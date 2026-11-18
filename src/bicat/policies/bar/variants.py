# SPDX-FileCopyrightText: 2026 Chaoqi Liu
#
# SPDX-License-Identifier: Apache-2.0

"""Concrete BAR policy variants.

The public policy matrix is method x codec x backbone, but those matrix cells do
not need one package each. This module keeps the concrete BAR variants together
while BAR core and backbone modules own the actual behavior.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from bicat.policies.bar.backbones.molmo.molmo_base import MolmoPolicyBase
from bicat.policies.bar.backbones.molmo.molmo_config import MolmoPolicyConfig
from bicat.policies.bar.backbones.pali.pali_base import PaliPolicyBase
from bicat.policies.bar.backbones.pali.pali_config import (
    PaliPolicyConfig,
)
from bicat.policies.core.action_tokens import action_tokenizer_config_factory


@dataclass
class BiCATMolmoPolicyConfig(MolmoPolicyConfig):
    """BiCAT BAR with Molmo2-ER and discrete-text proprioception."""

    name: str = "bar_bicat_molmo"
    action_tokenizer: dict[str, object] = field(
        default_factory=action_tokenizer_config_factory("bicat")
    )


class BiCATMolmoPolicy(MolmoPolicyBase):
    CONFIG_CLASS = BiCATMolmoPolicyConfig


@dataclass
class BiCATPaliPolicyConfig(PaliPolicyConfig):
    """Hyperparameters for bimanual temporal-tokenizer Pali VLM policy."""

    name: str = "bar_bicat_pali"
    action_tokenizer: dict[str, object] = field(
        default_factory=action_tokenizer_config_factory("bicat")
    )


class BiCATPaliPolicy(PaliPolicyBase):
    """BiCAT Pali policy routed through the blockwise VLM path."""

    CONFIG_CLASS = BiCATPaliPolicyConfig


__all__ = [
    "BiCATMolmoPolicy",
    "BiCATMolmoPolicyConfig",
    "BiCATPaliPolicy",
    "BiCATPaliPolicyConfig",
]
