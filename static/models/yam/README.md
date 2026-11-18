# YAM model used by the mirror-canonicalization demo

Source: MuJoCo Menagerie `i2rt_yam` (https://github.com/google-deepmind/mujoco_menagerie/tree/main/i2rt_yam),
MIT License, Copyright (c) 2025 i2rt robotics (see LICENSE). Derived from i2rt's public `yam.urdf`.

`yam.json` + `yam.bin` were generated from `yam.xml` and its STL meshes: each body's visual meshes are
transformed into the body frame, merged per material (black / white), given crease-aware normals, and
quantized (int16 positions, int8 normals, uint16/uint32 indices). Kinematics (body poses, joint ranges)
are copied unchanged from `yam.xml`. All joints rotate / slide about their local z-axis.

Sign vector used by the demo (paper, Bimanual YAM): s = (-1, 1, 1, 1, -1, -1, 1).
Checked with forward kinematics: with arms side by side, the right arm driven by s * q_L reproduces the
mirror image of the left gripper's orientation exactly (0.00 deg); positions differ by at most ~7 cm
because the YAM links have small lateral offsets (the hardware itself is not mirror-symmetric).
