# SPDX-FileCopyrightText: 2026 Chaoqi Liu
#
# SPDX-License-Identifier: Apache-2.0

"""Continuous encoder components for the standalone BiCAT tokenizer family."""

from bicat.codecs.tokens.bicat.config import (
    DEFAULT_RIGHT_ARM_SIGN,
    DEFAULT_SHARED_ACTION_MAX,
    DEFAULT_SHARED_ACTION_MIN,
    BiCATEncoderConfig,
)
from bicat.codecs.tokens.bicat.decoder import TimestepPairedBiCATDecoder
from bicat.codecs.tokens.bicat.encoder import BiCATEncoder
from bicat.codecs.tokens.bicat.modeling import (
    CausalDownsampleConv1d,
    CausalTemporalDownsampler,
    SharedCausalSelfAttention,
    SymmetricCausalCrossAttention,
    causal_attention_mask,
)
from bicat.codecs.tokens.bicat.tokenizer import BiCATTokenization, BiCATTokenizer

__all__ = [
    "DEFAULT_RIGHT_ARM_SIGN",
    "DEFAULT_SHARED_ACTION_MAX",
    "DEFAULT_SHARED_ACTION_MIN",
    "BiCATEncoder",
    "BiCATEncoderConfig",
    "BiCATTokenizer",
    "BiCATTokenization",
    "CausalDownsampleConv1d",
    "CausalTemporalDownsampler",
    "SharedCausalSelfAttention",
    "SymmetricCausalCrossAttention",
    "TimestepPairedBiCATDecoder",
    "causal_attention_mask",
]
