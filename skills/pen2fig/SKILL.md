---
name: pen2fig
description: |
  Port Pencil (.pen) designs into Figma with pen2fig. Use when asked to move, port, copy, sync or
  rebuild Pencil screens, frames, zones or components in Figma, or when a Pencil→Figma port has
  wrong layout, missing strokes, black colours or broken instances.
---

# Porting Pencil to Figma with pen2fig

You have the Pencil MCP (`execute`) and either the pen2fig Figma plugin or a `use_figma`-style MCP tool.
The `.pen` file is encrypted. Read it only through the Pencil MCP, never from disk.

## The loop (plugin route — preferred)

1. **Check the job server.** Make sure `pen2fig serve` is running and the developer has the pen2fig plugin open in Figma.
   `curl -s localhost:7331/health` should answer. If it doesn't, ask them to run `npx pen2fig serve` and open the plugin.
2. **Pick the frames.** List top-level frames cheaply in Pencil:
   `Get(null,(n,c)=>{c.skipChildren();Print(n.id+"\t"+n.name)})`
   Choose one zone at a time: 5–15 screens.
3. **Extract.** Run `npx pen2fig snippet <id…> --components` and execute the printed JS with the Pencil MCP.
   The output is large, so your MCP client saves it to a file. Note the path.
4. **Bundle.**
   `npx pen2fig bundle <that file> --page "<Figma page>" --pen-dir <folder of the .pen> -o bundle.json`
5. **Build.** `npx pen2fig push bundle.json --wait` prints the plugin's report as JSON.
6. **Read the report and fix:**
   - `status: "Δw,h"`: the screen size differs from Pencil. Look at the screenshot. It's usually a `fill_container` with nothing to fill, or text growth.
   - `issues[].kind === "text-overflow"`: check whether that row is meant to scroll. If it isn't, fix the source or the Figma node.
   - `missing-component`: a `ref` points at a component that wasn't extracted. Re-run the snippet with `--components`.
   - `warnings`: font fallbacks, detached instances and missing variables. A missing variable shows as magenta (#FF00FF).
7. **Re-run.** Pushing the same bundle replaces the frames it built before, by Pencil id. Iterate per zone.

## Without the plugin (`use_figma` route)

Use this when you can only run plugin code through an MCP tool, which has a per-call code size limit and no network:

- Load the engine once from `packages/core/dist/pen2fig-core.js` (27KB):
  `const P2F = new Function(src + ";return P2F")(); const E = await P2F.createEngine();`
  Then call `E.buildScreen(node, page, bounds)` for each screen.
- **When the bundle is too big to paste:** pack the JSON into an uncompressed PNG (zlib level 0, stored deflate). Upload it with the asset tool without a target node. In the plugin, read it back with `figma.getImageByHash(hash).getBytesAsync()`, parsing the IDAT stored blocks and stripping the row filter bytes. Delete the frame the upload placed.
- **Images:** the sandbox has no network. Upload each distinct image with the asset tool, then copy the returned hash to every node tagged `pen2fig/img`.

## Gotchas worth knowing before you debug

- A Pencil frame with no `layout` is a horizontal row.
- A stroke with no width draws nothing.
- Figma ignores nested size and direction overrides on instances without saying so. The engine checks and detaches. To inspect by hand, compare the value after setting it.
- A layer hidden in a main component is missing from its instances' `children`. Expose it with a boolean component property.
- A failed plugin call is rolled back entirely, including plugin data written before the error.
- Load every font of a text node (`getRangeAllFontNames`) before you change its characters or auto-resize.
- `findAll(n => n.visible)` still returns text inside hidden parents. Walk the tree and stop at hidden nodes.

See `docs/rules.md` in the pen2fig repo for the full rule list.
