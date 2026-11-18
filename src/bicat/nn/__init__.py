# SPDX-FileCopyrightText: 2026 Chaoqi Liu
#
# SPDX-License-Identifier: Apache-2.0

"""Shared neural network building blocks for BiCAT."""

from bicat.nn.architectures.transformer import Transformer, TransformerDecoder
from bicat.nn.blocks.attention import Attention, CrossAttention, SelfAttention
from bicat.nn.blocks.mlp import GatedMlp, Mlp
from bicat.nn.blocks.transformer_block import (
    Block,
    BlockAdaLN,
    DecoderBlock,
    DecoderBlockAdaLN,
)
from bicat.nn.embeddings.positional import (
    LearnedPosEmbed,
    RotaryPosEmbed,
    SinusoidPosEmbed,
    build_1d_sinusoid_pos_embed,
    build_2d_sinusoid_pos_embed,
)
from bicat.nn.embeddings.time import (
    SinusoidalScalarEmbedding,
    geometric_frequency_grid,
    sinusoidal_scalar_features,
)
from bicat.nn.layers.drop_path import DropPath, drop_path
from bicat.nn.layers.norm import Fp32LayerNorm, Fp32RMSNorm
from bicat.nn.vision.rgb_encoder import (
    ResNetSpatialSoftmaxEncoder,
    SpatialSoftmax,
    replace_bn_with_gn,
)

__all__ = [
    "Attention",
    "Block",
    "BlockAdaLN",
    "CrossAttention",
    "DecoderBlock",
    "DecoderBlockAdaLN",
    "DropPath",
    "Fp32LayerNorm",
    "Fp32RMSNorm",
    "GatedMlp",
    "Mlp",
    "LearnedPosEmbed",
    "SinusoidalScalarEmbedding",
    "RotaryPosEmbed",
    "SelfAttention",
    "SpatialSoftmax",
    "SinusoidPosEmbed",
    "Transformer",
    "TransformerDecoder",
    "build_1d_sinusoid_pos_embed",
    "build_2d_sinusoid_pos_embed",
    "ResNetSpatialSoftmaxEncoder",
    "geometric_frequency_grid",
    "replace_bn_with_gn",
    "sinusoidal_scalar_features",
    "drop_path",
]
