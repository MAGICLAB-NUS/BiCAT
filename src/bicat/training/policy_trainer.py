# SPDX-FileCopyrightText: 2026 Chaoqi Liu
#
# SPDX-License-Identifier: Apache-2.0

"""Policy trainer: DefaultTrainer specialization for policy learning."""

from __future__ import annotations

from typing import Any

import torch
from lerobot.datasets.lerobot_dataset import LeRobotDataset
from omegaconf import DictConfig, OmegaConf

from bicat.core.types import PolicyIO
from bicat.data.lerobot_adapter import (
    LeRobotDatasetAdapter,
    ensure_lerobot_dataset_available,
)
from bicat.data.multi_source_lerobot import (
    MultiSourceLeRobotDatasetAdapter,
    source_episode_counts,
)
from bicat.data.utils import stats_to_tensors
from bicat.policies.factory import make_io_from_metadata, make_policy
from bicat.processing.pipelines import make_policy_pre_post_processors
from bicat.training.core.dataset_filtering import (
    filter_episode_pool,
    load_action_stats_payload,
    load_excluded_episode_ids,
)
from bicat.training.core.distributed import is_distributed_padding_batch
from bicat.training.core.eval_collectors import (
    ReconstLossCollector,
    ReconstructionBatchContext,
    ReconstructionMetricPipeline,
    build_reconstruction_info_annotators,
    build_reconstruction_metric_collectors,
)
from bicat.training.core.eval_memory import release_cuda_eval_memory
from bicat.training.core.trainer import (
    DefaultTrainer,
    resolve_sampler_frame_drops,
)


def _build_reconstruction_obs(
    *,
    policy: Any,
    batch: dict[str, Any],
    fallback_io: PolicyIO | None,
) -> dict[str, Any]:
    """Build reconstruction observations from exact PolicyIO keys."""
    io = getattr(policy, "io", None) or fallback_io
    obs_keys = getattr(io, "obs_keys", None)
    if io is None or obs_keys is None:
        raise RuntimeError(
            "PolicyTrainer.reconstruct requires a PolicyIO on policy.io or trainer.io "
            "to select reconstruction observation keys."
        )

    obs_key_list = list(obs_keys)
    missing = [key for key in obs_key_list if key not in batch]
    if missing:
        available_obs = sorted(
            key
            for key in batch
            if isinstance(key, str) and key.startswith("observation.")
        )
        available_text = available_obs if available_obs else "none"
        raise KeyError(
            "Missing PolicyIO observation key(s) during reconstruction: "
            f"{missing}. Available observation keys in batch: {available_text}."
        )

    obs = {key: batch[key] for key in obs_key_list}
    language_key = getattr(io, "language_key", None)
    if isinstance(language_key, str) and language_key:
        if language_key not in batch:
            raise KeyError(
                "Missing PolicyIO language key during reconstruction: "
                f"{language_key!r}."
            )
        obs[language_key] = batch[language_key]
    return obs


def _static_reconstruction_prediction(
    *,
    mode: str,
    batch: dict[str, Any],
    gt_action: torch.Tensor,
) -> tuple[torch.Tensor, dict[str, Any]]:
    """Build a model-free reconstruction baseline in raw action space."""
    if mode == "zero":
        return torch.zeros_like(gt_action), {"reconst_action_mode": mode}

    if mode != "hold":
        raise ValueError(
            "trainer.reconst_action_mode must be one of "
            f"{{'policy', 'zero', 'hold'}}, got {mode!r}."
        )

    state = batch.get("observation.state")
    if not isinstance(state, torch.Tensor):
        raise KeyError(
            "trainer.reconst_action_mode='hold' requires tensor key "
            "'observation.state' in the reconstruction batch."
        )
    if state.ndim == gt_action.ndim - 1:
        anchor = state.unsqueeze(1)
    elif state.ndim == gt_action.ndim:
        anchor = state[:, -1:]
    else:
        raise ValueError(
            "Hold reconstruction expects observation.state shape (B, D) or "
            f"(B, T_obs, D), got {tuple(state.shape)} for action shape "
            f"{tuple(gt_action.shape)}."
        )
    if anchor.shape[0] != gt_action.shape[0] or anchor.shape[-1] != gt_action.shape[-1]:
        raise ValueError(
            "Hold reconstruction requires observation.state and action to have "
            "matching batch and feature dimensions, got "
            f"state={tuple(state.shape)} action={tuple(gt_action.shape)}."
        )
    return anchor.expand_as(gt_action), {"reconst_action_mode": mode}


class PolicyTrainer(DefaultTrainer):
    """Extends DefaultTrainer with reconstruction eval."""

    def __init__(self, cfg: DictConfig) -> None:
        super().__init__(cfg)
        tc = cfg.trainer

        self.reconst_every = tc.reconst_every
        self.max_reconst_batches = tc.max_reconst_batches
        self.reconst_action_mode = (
            str(OmegaConf.select(tc, "reconst_action_mode", default="policy"))
            .strip()
            .lower()
        )
        if self.reconst_action_mode not in {"policy", "zero", "hold"}:
            raise ValueError(
                "trainer.reconst_action_mode must be one of "
                "{'policy', 'zero', 'hold'}, got "
                f"{self.reconst_action_mode!r}."
            )

    # ------------------------------------------------------------------
    # DefaultTrainer hooks
    # ------------------------------------------------------------------

    def _init_data(self) -> None:
        dc = self.cfg.dataset
        excluded_episodes = load_excluded_episode_ids(
            getattr(dc, "exclude_episodes_file", None)
        )
        stats_payload = load_action_stats_payload(
            getattr(dc, "action_stats_file", None)
        )
        self.filtered_action_stats = (
            None if stats_payload is None else stats_to_tensors(stats_payload)
        )
        sources = list(getattr(dc, "sources", []) or [])
        if sources:
            for source in sources:
                ensure_lerobot_dataset_available(
                    repo_id=source.repo_id,
                    runtime=self.runtime,
                    root=source.root,
                    episodes=None,
                    download_videos=True,
                    bypass_force_cache_sync=bool(
                        getattr(dc, "bypass_force_cache_sync", False)
                    ),
                )
        else:
            ensure_lerobot_dataset_available(
                repo_id=dc.repo_id,
                runtime=self.runtime,
                root=dc.root,
                episodes=dc.episodes,
                download_videos=True,
                bypass_force_cache_sync=bool(getattr(dc, "bypass_force_cache_sync", False)),
            )
        with self._dataset_init_context():
            temp_meta = LeRobotDataset(
                repo_id=sources[0].repo_id if sources else dc.repo_id,
                root=sources[0].root if sources else dc.root,
                episodes=dc.episodes if not sources else None,
            )
            observation_keys = getattr(dc, "observation_keys", None)
            self.io = make_io_from_metadata(
                temp_meta.meta.features,
                self.cfg.policy,
                observation_keys=(
                    list(observation_keys) if observation_keys is not None else None
                ),
                action_key=getattr(dc, "action_key", None),
            )
            if self.io.action_feature is None:
                raise RuntimeError(
                    "Policy trainer requires PolicyIO.action_feature to be defined."
                )
            self.action_key = self.io.action_feature.key
            self.io.fps = temp_meta.fps
            total_episodes = (
                sum(source_episode_counts(sources))
                if sources
                else int(temp_meta.meta.total_episodes)
            )
            configured_episodes = list(dc.episodes or range(total_episodes))
            all_episodes = filter_episode_pool(configured_episodes, excluded_episodes)
            if excluded_episodes and self.runtime.is_main_process:
                print(
                    f"[PolicyTrainer] Excluding {len(excluded_episodes)} episodes; "
                    f"training/validation pool contains {len(all_episodes)} episodes."
                )
            del temp_meta

            train_episodes, val_episodes = self._split_episodes(all_episodes)

            if sources:
                self.dataset = MultiSourceLeRobotDatasetAdapter(
                    sources=sources,
                    io=self.io,
                    episodes=train_episodes,
                    video_backend=dc.video_backend,
                )
            else:
                self.dataset = LeRobotDatasetAdapter(
                    repo_id=dc.repo_id,
                    io=self.io,
                    root=dc.root,
                    episodes=train_episodes,
                    video_backend=dc.video_backend,
                )
            self.io.fps = self.dataset.fps

        tasks_meta = getattr(self.dataset.meta, "tasks", None)
        has_tasks = False
        if tasks_meta is not None:
            if isinstance(tasks_meta, dict) or hasattr(tasks_meta, "__len__"):
                has_tasks = len(tasks_meta) > 0
            else:
                has_tasks = bool(tasks_meta)
        if has_tasks:
            self.io.language_key = "task"

        drop_n_first_frames, drop_n_last_frames = resolve_sampler_frame_drops(
            self.io,
            configured_drop_n_first_frames=self.tc.drop_n_first_frames,
            configured_drop_n_last_frames=self.tc.drop_n_last_frames,
        )

        self.dataloader = self.dataset.make_dataloader(
            batch_size=self.tc.batch_size,
            num_workers=self.tc.num_workers,
            shuffle=True,
            prefetch_factor=self.tc.prefetch_factor,
            use_episode_aware_sampler=self.tc.use_episode_aware_sampler,
            drop_n_first_frames=drop_n_first_frames,
            drop_n_last_frames=drop_n_last_frames,
            drop_last=True,
        )

        if val_episodes:
            with self._dataset_init_context():
                if sources:
                    self.val_dataset = MultiSourceLeRobotDatasetAdapter(
                        sources=sources,
                        io=self.io,
                        episodes=val_episodes,
                        video_backend=dc.video_backend,
                    )
                else:
                    self.val_dataset = LeRobotDatasetAdapter(
                        repo_id=dc.repo_id,
                        io=self.io,
                        root=dc.root,
                        episodes=val_episodes,
                        video_backend=dc.video_backend,
                    )
            self.val_dataloader = self.val_dataset.make_dataloader(
                batch_size=self.val_batch_size,
                num_workers=self.tc.num_workers,
                shuffle=False,
                prefetch_factor=self.tc.prefetch_factor,
                use_episode_aware_sampler=self.tc.use_episode_aware_sampler,
                drop_n_first_frames=drop_n_first_frames,
                drop_n_last_frames=drop_n_last_frames,
                drop_last=False,
            )
        else:
            self.val_dataset = None
            self.val_dataloader = None

    def _init_model(self) -> None:
        self.model = make_policy(self.cfg.policy, self.io)
        normalization_stats = self.dataset.stats
        filtered_action_stats = getattr(self, "filtered_action_stats", None)
        if filtered_action_stats is not None:
            normalization_stats = {**normalization_stats, **filtered_action_stats}
        self.model.set_normalization_stats(
            normalization_stats,
            modes=getattr(self.dataset, "normalization_modes", None),
        )

    def _validate_model_for_distributed_strategy(self) -> None:
        strategy = str(self.tc.distributed_strategy)
        if strategy != "fsdp":
            return
        validate_strategy = getattr(self.model, "validate_distributed_strategy", None)
        if callable(validate_strategy):
            validate_strategy(strategy)
            return
        raise ValueError(
            "Policy FSDP currently requires the policy model to validate support "
            "with validate_distributed_strategy('fsdp'). Use "
            "trainer.distributed_strategy=ddp for policies without that hook."
        )

    def _build_model_preprocessor(self):
        pre, post = make_policy_pre_post_processors()
        self.policy_postprocessor = post
        return pre

    def _required_tensor_keys(self, phase: str, batch: dict) -> set[str]:
        del phase
        required: set[str] = set(self.io.obs_keys)
        if self.action_key is None:
            raise RuntimeError("action_key must be initialized before batch validation")
        required.add(self.action_key)
        for key in list(required):
            pad_key = f"{key}_is_pad"
            if pad_key in batch:
                required.add(pad_key)
        language_key = self.io.language_key
        if isinstance(language_key, str) and isinstance(
            batch.get(language_key), torch.Tensor
        ):
            required.add(language_key)
        return required

    def _periodic_eval_hooks(self):
        return [
            (self.tc.val_every, self.validate, False),
            (self.reconst_every, self.reconstruct, True),
        ]

    def _on_train_end(self) -> None:
        super()._on_train_end()

    # ------------------------------------------------------------------
    # Policy-specific eval hooks
    # ------------------------------------------------------------------

    def reconstruct(self) -> dict[str, float]:
        if self.val_dataloader is None:
            return {}
        if self.action_key is None:
            raise RuntimeError("action_key must be initialized before reconstruct")
        action_key = self.action_key
        action_mode = str(getattr(self, "reconst_action_mode", "policy"))

        warned_missing_chunk_api = False
        total_batches = len(self.val_dataloader)
        if self.max_reconst_batches:
            total_batches = min(total_batches, int(self.max_reconst_batches))
        reconst_iter = self._eval_progress(
            enumerate(self.val_dataloader),
            desc="Reconstruction",
            total=total_batches,
        )

        with self._ema_eval_scope() as policy:
            pipeline = ReconstructionMetricPipeline(
                [
                    ReconstLossCollector(device=self.device),
                    *build_reconstruction_metric_collectors(
                        policy=policy,
                        cfg=self.cfg,
                        device=self.device,
                    ),
                ],
                annotators=build_reconstruction_info_annotators(
                    policy=policy,
                    cfg=self.cfg,
                    device=self.device,
                ),
            )
            policy.eval()
            with torch.inference_mode():
                for i, batch in reconst_iter:
                    if self.max_reconst_batches and i >= self.max_reconst_batches:
                        break
                    is_padding = is_distributed_padding_batch(self.val_dataloader, i)
                    batch = self._move_batch_tensors_to_device(
                        batch, phase="reconstruct"
                    )
                    batch = self.preprocess_batch(batch)
                    with self.runtime.autocast():
                        if action_mode == "policy":
                            obs = _build_reconstruction_obs(
                                policy=policy,
                                batch=batch,
                                fallback_io=getattr(self, "io", None),
                            )
                            try:
                                pred_action, reconst_info = policy.predict_action_chunk(
                                    obs,
                                    decode_temperature=0.0,
                                    decode_top_k=1,
                                )
                            except NotImplementedError:
                                if (
                                    self.runtime.is_main_process
                                    and not warned_missing_chunk_api
                                ):
                                    print(
                                        "Policy does not implement predict_action_chunk(); "
                                        "skipping reconstruction metric."
                                    )
                                    warned_missing_chunk_api = True
                                continue
                        else:
                            pred_action, reconst_info = (
                                _static_reconstruction_prediction(
                                    mode=action_mode,
                                    batch=batch,
                                    gt_action=batch[action_key],
                                )
                            )

                    gt_action = batch[action_key]
                    if pred_action.shape != gt_action.shape:
                        raise RuntimeError(
                            "Reconstruction shape mismatch: "
                            f"pred_action={tuple(pred_action.shape)} vs gt_action={tuple(gt_action.shape)}"
                        )
                    if is_padding:
                        continue
                    pipeline.update(
                        ReconstructionBatchContext(
                            pred_action=pred_action,
                            gt_action=gt_action,
                            batch=batch,
                            reconst_info=reconst_info,
                            policy=policy,
                            action_key=action_key,
                        )
                    )

        self.model.train()
        release_cuda_eval_memory(self.device)
        pipeline.reduce(self.runtime)
        return pipeline.finalize()

