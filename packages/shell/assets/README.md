# Shell icon

Four sources sized to Apple's app-icon template (824 px squircle on a 1024 px canvas, the comma at
37% of it, centred): `icon.svg` and `icon-dark.svg`, the two-ink print (an ink layer misregistered
sideways under the hand's vermilion) on paper and on ink, for 64 px and up; `icon-small.svg` and
`icon-dark-small.svg`, one ink, for 16 px and 32 px, where a second layer cannot read as anything
but a smear. `icon.icns` (light; an icns holds one image) and the two 512 px PNGs the running app
sets as its Dock image by system appearance are rendered from them; regenerate after editing:

```sh
cd packages/shell/assets
mkdir -p glosa.iconset
for s in 16 32 128 256 512; do
  d=$((s*2)); src=icon.svg; [ $s -lt 64 ] && src=icon-small.svg; src2=icon.svg; [ $d -lt 64 ] && src2=icon-small.svg
  rsvg-convert -w $s -h $s $src -o glosa.iconset/icon_${s}x${s}.png
  rsvg-convert -w $d -h $d $src2 -o glosa.iconset/icon_${s}x${s}@2x.png
done
iconutil -c icns glosa.iconset -o icon.icns
rsvg-convert -w 512 -h 512 icon.svg -o icon-512.png
rsvg-convert -w 512 -h 512 icon-dark.svg -o icon-dark-512.png
rm -r glosa.iconset
```

`icon.icns` is what packaging will use; the PNGs are what the app puts in the Dock at runtime,
light or dark with the system, since a bare Electron shows its own atom otherwise.
