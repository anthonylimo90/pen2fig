# pen2fig

Port [Pencil](https://pencil.dev) (`.pen`) designs into Figma, screen by screen, without losing layout.

pen2fig has three parts:

- **An engine** that turns Pencil nodes into real Figma nodes: auto layout, variables, components and instances, not flattened pictures.
- **An extractor** that pulls frames out of Pencil through its MCP server.
- **A Figma plugin** that builds the result. A coding agent (Claude Code, Cursor, …) can drive it end to end.

The engine was built while porting a 600-frame product file. Every rule in it comes from a frame that went wrong; see [docs/rules.md](docs/rules.md).

```
agent / you                              Figma
───────────                              ─────
Pencil MCP ── pen2fig snippet ─▶ output
pen2fig bundle output ─▶ bundle.json
pen2fig serve  (localhost:7331)  ◀─poll─  pen2fig plugin (open once)
pen2fig push bundle.json --wait  ─job──▶  build → images → verify
          ◀──────────── report ─────────  text overflow, size vs Pencil, missing components
```

## Quick start

Requires Node 23.6 or newer. The CLI runs as TypeScript directly, with no build step.

```bash
git clone https://github.com/anthonylimo90/pen2fig && cd pen2fig
npm install
npm run build            # builds packages/plugin/dist and packages/core/dist
```

**Install the plugin in Figma (once).** In the Figma desktop app, choose *Plugins → Development → Import plugin from manifest…* and pick `packages/plugin/manifest.json`. Then run *pen2fig* from *Plugins → Development*.

**Try the example.** Drop `examples/bundle.example.json` onto the plugin window. A page called *pen2fig example* appears.

**Port real frames.** Follow these steps:

1. **Get the extraction script.** List the Pencil node ids you want, then print a script for them:
   ```bash
   npx pen2fig snippet Ab12C De34F --components
   ```
2. **Run it in Pencil.** Paste the script into the Pencil MCP `execute` tool, with the `.pen` file open.
3. **Save the output.** Your agent's MCP client saves the large output to a file.
4. **Turn the output into a bundle:**
   ```bash
   npx pen2fig bundle path/to/output.txt --page "Checkout" --pen-dir ~/designs -o bundle.json
   ```
5. **Start the job server.** Run it, then open the plugin in Figma and leave it running:
   ```bash
   npx pen2fig serve
   ```
6. **Queue the build and read the report:**
   ```bash
   npx pen2fig push bundle.json --wait
   ```

Re-running a bundle replaces the frames it built before (a ledger keyed by Pencil id), so you can iterate on one zone.

The snippet also extracts the file's variables. The plugin imports them into a Figma collection called *Pencil* before it builds anything, so `$name` references bind to real variables. A re-run updates that collection in place. Variables of the same name in your own collections are left alone and used as they are. Pass `--no-variables` to `snippet` or `bundle` to skip this.

Lucide icons work the same way. `bundle` fetches the SVG of every Lucide icon the frames use (from `lucide-static` 1.54.0 on unpkg, or `--lucide <version>`) and embeds it in the bundle. The plugin then turns each one into an `Icon/<name>` component on an *Icons* page. If the file already has a component with that name, the plugin uses yours. Offline, point `--icons-dir` at a `lucide-static/icons` folder. `--no-icons` skips the step. Lucide is ISC-licensed; each component keeps its source URL in plugin data.

## What gets mapped

| Pencil | Figma |
|---|---|
| frame, default horizontal layout, `gap`, `padding`, justify/align | frame with auto layout |
| `fill_container` / `fit_content` (with fallbacks) | FILL / HUG sizing, resolved after insertion |
| variables and themes (`GetVariables()`) | a *Pencil* variable collection, one mode per theme (light, dark, …), aliases kept |
| `$variable` colours, numbers, fonts | bound Figma variables |
| `reusable` nodes and `ref` instances, `descendants` overrides | components, instances and overrides. The instance is detached only when Figma refuses an override |
| text (family, weight, size, line height, tracking, growth) | text, with the nearest installed style |
| Lucide icons (`icon` / `icon_font`) | instances of `Icon/<name>` components, imported from Lucide onto an *Icons* page |
| icons from other libraries | instances of `Icon/<name>` components that you register |
| rectangle, ellipse (arcs), polygon, path (SVG geometry) | shapes and vectors |
| linear/radial/angular gradients, shadows, blurs | paints and effects |
| image fills | placeholders that the plugin replaces with real bytes from `pen2fig serve` |
| shader fills | the `u_base` colour (render the shader to an image yourself) |

The [known gaps](docs/rules.md#gaps) are listed with the rules.

## Packages

| Package | What it is |
|---|---|
| `packages/core` | The engine (`createEngine`), pure translation rules, bundle schema and checks. `dist/pen2fig-core.js` is a single script for agents that can only run plugin code through an MCP tool. |
| `packages/cli` | `pen2fig snippet / bundle / serve / push / report`. No dependencies. |
| `packages/plugin` | The Figma plugin: manual drop, or polling `pen2fig serve`. |
| `skills/pen2fig` | A Claude Code skill that runs the whole loop. |

## Using it from an agent

Copy `skills/pen2fig` into `~/.claude/skills/` (or your agent's equivalent). The skill tells the agent how to:

- extract a zone,
- bundle it and push it,
- read the report,
- fix what's off and re-run.

If the agent can only reach Figma through an MCP `use_figma`-style tool, load `packages/core/dist/pen2fig-core.js` in that tool instead of the plugin. The skill covers this route too.

## Status

This is an early release. The engine reproduces the reference file node for node. The plugin and CLI are new.

Pencil's file format isn't documented and may change. Bundles carry a version, and the plugin rejects a version it doesn't know rather than building something subtly wrong.

pen2fig is independent and not affiliated with Pencil or Figma.

## License

MIT
