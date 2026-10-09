# Shader renderers

Figma can't run GLSL. When a Pencil node has a `shader` fill, render it to a PNG at twice the node
size and use that as an image fill. These are numpy ports of two dot-field shaders, as worked examples
of the method:

1. **Port the shader.** Write hash, noise and fbm as vectorised array functions.
2. **Set up coordinates.** Build `gl_FragCoord` from a meshgrid offset by +0.5, then flip y, because GL's origin is bottom-left.
3. **Map the uniforms 1:1.** Resolve colour variables to hex first.

```bash
pip install numpy pillow
# W H base dot  bottom top left right  out.png  [scale flow dotsize]
python3 dotfield.py 1440 900 "#F6F7FB" "#AEBBD4" .6 .2 .2 .6 hero.png 64 .18 .085
# W H base deep dot  scale flow dotsize  out.png
python3 dotflow.py 1440 900 "#F6F7FB" "#E9EEF7" "#AEBBD4" 58 .65 .095 auth.png
```

The output is static. That matches what a static mock shows anyway.
