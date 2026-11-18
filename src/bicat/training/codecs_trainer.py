# SPDX-FileCopyrightText: 2026 Chaoqi Liu
#
# SPDX-License-Identifier: Apache-2.0

"""Codec trainer: DefaultTrainer specialization for action codecs."""

from __future__ import annotations

from contextlib import AbstractContextManager
from typing import Any, cast

import torch
from lerobot.datasets.lerobot_dataset import LeRobotDataset
from omegaconf import DictConfig, OmegaConf

from bicat.codecs.factory import make_codec
from bicat.core.config import require_config_dict
from bicat.core.types import PolicyIO
from bicat.data.lerobot_adapter import (
    LeRobotActionOnlyDatasetAdapter,
    _episode_bounds_from_metadata,
    ensure_lerobot_dataset_available,
)
from bicat.data.utils import resolve_action_feature_from_metadata, stats_to_tensors
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
    build_reconstruction_metric_collectors,
)
from bicat.training.core.trainer import (
    DefaultTrainer,
    resolve_sampler_frame_drops,
)


def _resolve_codec_build_cfg(
    codec_cfg: DictConfig | dict[str, Any],
    *,
    dataset_action_dim: int,
    is_main_process: bool,
) -> dict[str, Any]:
    if isinstance(codec_cfg, DictConfig):
        cfg_dict = OmegaConf.to_container(codec_cfg, resolve=True)
    else:
        cfg_dict = dict(codec_cfg)
    if not isinstance(cfg_dict, dict):
        raise TypeError(f"codec config must resolve to a dict, got {type(cfg_dict)!r}")
    cfg_dict = cast(dict[str, Any], cfg_dict)

    pretrained_path = cfg_dict.get("pretrained_path")
    configured_action_dim = cfg_dict.get("action_dim")
    if not pretrained_path:
        if (
            configured_action_dim is not None
            and int(configured_action_dim) != dataset_action_dim
            and is_main_process
        ):
            print(
                f"[CodecsTrainer] Overriding codec.action_dim={configured_action_dim} "
                f"with dataset action_dim={dataset_action_dim}."
            )
        cfg_dict["action_dim"] = dataset_action_dim
    return cfg_dict


def _extract_codec_action_dim(codec: torch.nn.Module) -> int | None:
    action_dim = getattr(codec, "action_dim", None)
    if action_dim is None:
        cfg = getattr(codec, "config", None)
        action_dim = getattr(cfg, "action_dim", None)
    return int(action_dim) if action_dim is not None else None


def _supports_train_loop(codec: torch.nn.Module, optim_params: list[dict]) -> bool:
    del codec
    return bool(optim_params)


def _should_skip_codec_fit(cfg: Any) -> bool:
    trainer_cfg = getattr(cfg, "trainer", None)
    return bool(getattr(trainer_cfg, "skip_codec_fit", False))


class CodecsTrainer(DefaultTrainer):
    """Training loop specialization for action codecs."""

    def __init__(self, cfg: DictConfig) -> None:
        self.reconst_every = cfg.trainer.reconst_every
        self.max_reconst_batches = cfg.trainer.max_reconst_batches
        super().__init__(cfg)

    # ------------------------------------------------------------------
    # DefaultTrainer hooks
    # ------------------------------------------------------------------

    def _validate_distributed_config(self) -> None:
        if str(self.tc.distributed_strategy) == "fsdp":
            raise ValueError(
                "Codec training does not support trainer.distributed_strategy=fsdp. "
                "Use ddp for codec training; FSDP is currently reserved for "
                "VLM-based policy training."
            )
        super()._validate_distributed_config()

    def _init_data(self) -> None:
        dc = self.cfg.dataset
        excluded_episodes = load_excluded_episode_ids(
            getattr(dc, "exclude_episodes_file", None)
        )

        self.filtered_action_stats = None
        stats_payload = load_action_stats_payload(
            getattr(dc, "action_stats_file", None)
        )
        if stats_payload is not None:
            self.filtered_action_stats = stats_to_tensors(stats_payload)
        ensure_lerobot_dataset_available(
            repo_id=dc.repo_id,
            runtime=self.runtime,
            root=dc.root,
            episodes=dc.episodes,
            download_videos=False,
            bypass_force_cache_sync=bool(getattr(dc, "bypass_force_cache_sync", False)),
        )
        temp_ds = LeRobotDataset(
            repo_id=dc.repo_id,
            root=dc.root,
            episodes=dc.episodes,
        )
        configured_episodes = list(dc.episodes or range(temp_ds.meta.total_episodes))
        all_episodes = filter_episode_pool(configured_episodes, excluded_episodes)
        if excluded_episodes and self.runtime.is_main_process:
            print(
                f"[CodecsTrainer] Excluding {len(excluded_episodes)} episodes; "
                f"training/validation pool contains {len(all_episodes)} episodes."
            )
        meta_features = temp_ds.meta.features
        action_feature = resolve_action_feature_from_metadata(
            meta_features,
            action_key=getattr(dc, "action_key", None),
            context="dataset metadata for codec training",
        )
        self.action_key = action_feature.key
        action_shape = action_feature.shape
        self.dataset_action_dim = int(action_shape[0])
        action_horizon = int(self.cfg.codec.action_horizon)
        if action_horizon <= 0:
            raise ValueError(f"codec.action_horizon must be > 0, got {action_horizon}.")
        io = PolicyIO(
            obs_features=[],
            action_feature=action_feature,
            n_obs_steps=0,
            n_action_steps=action_horizon,
            fps=temp_ds.fps,
        )
        self.io = io
        episodes_meta = getattr(temp_ds.meta, "episodes", None)
        if episodes_meta is not None:
            # Fail fast when a configured episode is absent from metadata.
            episode_bounds = _episode_bounds_from_metadata(episodes_meta)
            for episode in all_episodes:
                if int(episode) not in episode_bounds:
                    raise ValueError(
                        f"dataset meta.episodes does not contain episode {int(episode)}."
                    )
        del temp_ds

        train_episodes, val_episodes = self._split_episodes(all_episodes)

        adapter_kwargs: dict[str, Any] = {
            "repo_id": dc.repo_id,
            "io": io,
            "root": dc.root,
            "episodes": train_episodes,
            "video_backend": dc.video_backend,
        }
        self.dataset = LeRobotActionOnlyDatasetAdapter(
            **adapter_kwargs,
        )
        drop_n_first_frames, drop_n_last_frames = resolve_sampler_frame_drops(
            io,
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
        # Keep an unsharded main-rank loader for bootstrap-only codec fit().
        # Fitting BPE/other non-gradient codecs on rank 0 must see the
        # dataset stream, not only rank 0's training shard.
        self.fit_dataloader = self.dataset.make_dataloader(
            batch_size=self.tc.batch_size,
            num_workers=self.tc.num_workers,
            shuffle=True,
            prefetch_factor=self.tc.prefetch_factor,
            use_episode_aware_sampler=self.tc.use_episode_aware_sampler,
            drop_n_first_frames=drop_n_first_frames,
            drop_n_last_frames=drop_n_last_frames,
            drop_last=False,
        )

        if val_episodes:
            val_adapter_kwargs = dict(adapter_kwargs)
            val_adapter_kwargs["episodes"] = val_episodes
            self.val_dataset = LeRobotActionOnlyDatasetAdapter(**val_adapter_kwargs)
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

        if bool(getattr(self.tc, "reconstruct_on_train", False)):
            if val_episodes:
                raise ValueError("reconstruct_on_train requires trainer.val_ratio=0.0.")
            self.val_dataset = self.dataset
            self.val_dataloader = self.dataset.make_dataloader(
                batch_size=self.val_batch_size,
                num_workers=self.tc.num_workers,
                shuffle=False,
                prefetch_factor=self.tc.prefetch_factor,
                use_episode_aware_sampler=self.tc.use_episode_aware_sampler,
                drop_n_first_frames=drop_n_first_frames,
                drop_n_last_frames=drop_n_last_frames,
                drop_last=False,
            )

    def _init_model(self) -> None:
        codec_build_cfg = _resolve_codec_build_cfg(
            self.cfg.codec,
            dataset_action_dim=self.dataset_action_dim,
            is_main_process=self.runtime.is_main_process,
        )
        self.model = make_codec(codec_build_cfg)
        self.model.set_io(self.io)

        codec_action_dim = _extract_codec_action_dim(self.model)
        if codec_action_dim is not None and codec_action_dim != self.dataset_action_dim:
            pretrained_path = codec_build_cfg.get("pretrained_path")
            where = (
                f"pretrained codec at {pretrained_path}"
                if pretrained_path
                else "codec config"
            )
            raise ValueError(
                f"Codec action_dim mismatch: dataset action_dim={self.dataset_action_dim}, "
                f"but {where} has action_dim={codec_action_dim}. "
                "Use a matching checkpoint or dataset."
            )
        normalization_stats = self.filtered_action_stats or self.dataset.stats
        self.model.set_normalization_stats(
            normalization_stats,
            modes=getattr(self.dataset, "normalization_modes", None),
        )

    def _get_optim_params(self) -> list[dict]:
        model = self.runtime.unwrap_model(self.model)
        get_optim_params = getattr(model, "get_optim_params", None)
        if not callable(get_optim_params):
            return []
        return cast(list[dict], get_optim_params())

    def _resolve_run_train_loop(self, optim_params: list[dict]) -> bool:
        return _supports_train_loop(self.model, optim_params)

    def _non_trainable_message(self) -> str | None:
        return (
            "Codec does not support train-time optimization; "
            "running stats bootstrap and checkpoint export only."
        )

    def _training_description(self) -> str:
        return "Codec Training"

    def _periodic_eval_hooks(self):
        return [
            (self.tc.val_every, self.validate, False),
            (self.reconst_every, self.reconstruct, True),
        ]

    def _required_tensor_keys(self, phase: str, batch: dict) -> set[str]:
        del phase
        if self.action_key is None:
            raise RuntimeError(
                "CodecsTrainer action_key must be resolved before batching."
            )
        required = {self.action_key}
        pad_key = f"{self.action_key}_is_pad"
        if pad_key in batch:
            required.add(pad_key)
        if "observation.state" in batch:
            required.add("observation.state")
        return required

    def _publish_training_context_to_model(self) -> None:
        super()._publish_training_context_to_model()
        model = self.runtime.unwrap_model(self.model)
        set_training_epoch = getattr(model, "set_training_epoch", None)
        if not callable(set_training_epoch):
            return

        batches_per_epoch = len(self.dataloader)
        if batches_per_epoch <= 0:
            raise ValueError(
                "Codec training dataloader must contain at least one batch."
            )
        batches_seen = getattr(self, "_training_batches_seen", None)
        if batches_seen is None:
            accumulation_steps = max(
                1,
                int(getattr(self.tc, "gradient_accumulation_steps", 1)),
            )
            batches_seen = int(self.global_step) * accumulation_steps
        set_training_epoch(int(batches_seen) // batches_per_epoch)

    def train_step(self, batch: dict) -> tuple[torch.Tensor, dict[str, float], bool]:
        result = super().train_step(batch)
        batches_seen = getattr(self, "_training_batches_seen", None)
        if batches_seen is None:
            accumulation_steps = max(
                1,
                int(getattr(self.tc, "gradient_accumulation_steps", 1)),
            )
            batches_seen = int(self.global_step) * accumulation_steps
        self._training_batches_seen = int(batches_seen) + 1
        return result

    def _run_without_training_loop(self) -> None:
        unwrapped = self.runtime.unwrap_model(self.model)

        def _fit_on_main_rank() -> None:
            if not self.runtime.is_main_process:
                return
            if _should_skip_codec_fit(self.cfg):
                print(
                    "[CodecsTrainer] Skipping codec fit(); bootstrapping stats/checkpoint only."
                )
            elif hasattr(unwrapped, "fit") and callable(unwrapped.fit):
                self._run_fit(unwrapped)

        main_process_first = getattr(self.runtime, "main_process_first", None)
        if callable(main_process_first):
            with cast(AbstractContextManager[None], main_process_first()):
                _fit_on_main_rank()
        else:
            _fit_on_main_rank()
            self.runtime.wait_for_everyone()

        if bool(getattr(getattr(self, "tc", None), "reconstruct_on_train", False)):
            metrics = self.reconstruct()
            if self.runtime.is_main_process:
                self.logger.log(
                    self._format_logged_metrics(metrics, default_group="train"), step=0
                )
        self.save_latest_checkpoint()
        rank0_error = None
        if self.runtime.is_main_process:
            try:
                self.logger.log({"codec/bootstrap_complete": 1.0}, step=0)
                print(
                    "Codec bootstrap complete. Checkpoint saved with dataset normalization stats."
                )
            except BaseException as exc:
                rank0_error = (
                    "Codec bootstrap logging failed on rank 0: "
                    f"{type(exc).__name__}: {exc}"
                )
        broadcast_object = getattr(self.runtime, "broadcast_object", None)
        if callable(broadcast_object):
            rank0_error = broadcast_object(rank0_error, src=0)
        if rank0_error is not None:
            raise RuntimeError(str(rank0_error))
        self._on_train_end()

    def _run_fit(self, codec: torch.nn.Module) -> None:
        """Collect action chunks from the dataloader and call fit()."""
        max_chunks = int(self.cfg.codec.max_fit_chunks)
        if self.runtime.is_main_process:
            print(
                f"[CodecsTrainer] Collecting up to {max_chunks} action chunks for fit()..."
            )
        chunks: list[torch.Tensor] = []
        total = 0
        fit_dataloader = getattr(self, "fit_dataloader", self.dataloader)
        for batch in fit_dataloader:
            actions = batch[self.action_key]
            if isinstance(actions, torch.Tensor):
                actions = actions.detach().cpu()
            chunks.append(actions)
            total += actions.shape[0]
            if total >= max_chunks:
                break
        all_actions = torch.cat(chunks, dim=0)[:max_chunks]
        if self.runtime.is_main_process:
            print(f"[CodecsTrainer] Fitting codec on {all_actions.shape[0]} chunks...")
        fit_fn = getattr(codec, "fit", None)
        if not callable(fit_fn):
            raise TypeError(
                f"Codec {type(codec).__name__} does not expose a callable fit(...) method."
            )
        fit_fn(all_actions)
        if self.runtime.is_main_process:
            print("[CodecsTrainer] fit() complete.")

    def _serialize_model_config(self, model: torch.nn.Module):
        return require_config_dict(model.config)

    # ------------------------------------------------------------------
    # Codec reconstruction eval hook
    # ------------------------------------------------------------------

    def reconstruct(self) -> dict[str, float]:
        # Keep evaluation from advancing the RNG used by training dropout.
        devices = [self.device] if self.device.type == "cuda" else []
        with torch.random.fork_rng(devices=devices):
            return self._reconstruct_impl()

    def _reconstruct_impl(self) -> dict[str, float]:
        if self.val_dataloader is None:
            return {}
        if self.action_key is None:
            raise RuntimeError("action_key must be initialized before reconstruct")
        action_key = self.action_key

        total_batches = len(self.val_dataloader)
        if self.max_reconst_batches:
            total_batches = min(total_batches, int(self.max_reconst_batches))
        reconst_iter = self._eval_progress(
            enumerate(self.val_dataloader),
            desc="Reconstruction",
            total=total_batches,
        )
        with self._ema_eval_scope() as codec:
            codec.eval()
            collectors = build_reconstruction_metric_collectors(
                policy=codec,
                cfg=getattr(self, "cfg", None),
                device=self.device,
            )
            default_loss_owners = [
                collector
                for collector in collectors
                if bool(
                    getattr(
                        collector,
                        "owns_default_reconstruction_loss",
                        False,
                    )
                )
            ]
            if len(default_loss_owners) > 1:
                owner_names = ", ".join(
                    type(collector).__name__ for collector in default_loss_owners
                )
                raise RuntimeError(
                    "Multiple registered reconstruction metric collectors claim "
                    "ownership of 'val_reconst_loss': "
                    f"{owner_names}."
                )
            if not default_loss_owners:
                collectors.insert(0, ReconstLossCollector(device=self.device))
            metric_pipeline = ReconstructionMetricPipeline(collectors)
            with torch.inference_mode():
                for i, batch in reconst_iter:
                    if self.max_reconst_batches and i >= self.max_reconst_batches:
                        break
                    if is_distributed_padding_batch(self.val_dataloader, i):
                        continue
                    batch = self._move_batch_tensors_to_device(
                        batch, phase="reconstruct"
                    )
                    actions = batch[action_key]
                    with self.runtime.autocast():
                        recon_actions, reconst_info = _reconstruct_actions(
                            codec,
                            actions,
                            batch=batch,
                            action_key=action_key,
                        )
                    metric_pipeline.update(
                        ReconstructionBatchContext(
                            pred_action=recon_actions,
                            gt_action=actions,
                            batch=batch,
                            reconst_info=reconst_info,
                            policy=codec,
                            action_key=action_key,
                        )
                    )
        self.model.train()

        metric_pipeline.reduce(self.runtime)
        metrics = metric_pipeline.finalize()
        if bool(getattr(getattr(self, "tc", None), "reconstruct_on_train", False)):
            return {
                "train_reconst" + key[len("val_reconst"):]
                if key.startswith("val_reconst") else key: value
                for key, value in metrics.items()
            }
        return metrics


def _reconstruct_actions(
    codec: torch.nn.Module,
    actions: torch.Tensor,
    *,
    batch: dict[str, Any] | None = None,
    action_key: str = "action",
) -> tuple[torch.Tensor, dict[str, Any]]:
    reconstruct_with_info = getattr(codec, "reconstruct_with_info", None)
    if callable(reconstruct_with_info):
        reconstruction_batch = {action_key: actions} if batch is None else batch
        result = reconstruct_with_info(
            actions,
            batch=reconstruction_batch,
            action_key=action_key,
        )
        if not isinstance(result, tuple) or len(result) != 2:
            raise TypeError(
                "reconstruct_with_info(...) must return "
                "(reconstruction, information dictionary)."
            )
        reconstruction, info = result
        if not isinstance(reconstruction, torch.Tensor):
            raise TypeError(
                "reconstruct_with_info(...) reconstruction must be a tensor."
            )
        if not isinstance(info, dict):
            raise TypeError(
                "reconstruct_with_info(...) must return an information dictionary."
            )
        return reconstruction, cast(dict[str, Any], info)

    autoencode = getattr(codec, "autoencode", None)
    if callable(autoencode):
        return cast(torch.Tensor, autoencode(actions)), {}

    tokenize = getattr(codec, "tokenize", None)
    detokenize = getattr(codec, "detokenize", None)
    if callable(tokenize) and callable(detokenize):
        tokens = tokenize(actions)
        return cast(torch.Tensor, detokenize(tokens)), {}

    raise TypeError(
        f"Codec {type(codec).__name__} must expose autoencode(...) or tokenize(...)/detokenize(...) "
        "for reconstruction evaluation."
    )
