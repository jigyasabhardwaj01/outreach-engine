# The motion layer

What was taken from [kivoagentic.ai](https://www.kivoagentic.ai/), what it was
mapped onto here, and what was deliberately left behind.

## What Kivo actually does

Inspected on 19 November 2026 at 1440×900, by reading the live DOM, the
computed styles, the running animations and the canvases rather than by
looking at screenshots.

| Effect | How it is built there |
|---|---|
| Dotted sphere | Procedural, not an image — the page ships 18 images and none of them is the sphere. Drawn as a point cloud in WebGL, grey when idle and orange when its section is active |
| Dot-field terrain | A second WebGL canvas, a noise-displaced grid of points, in a `sticky top-0 h-[100svh]` section scrubbed by scroll |
| Particle field on dark | A 2D canvas over a near-black `#0e0d0c` panel |
| Orbit rings | Plain CSS: `absolute inset-0 rounded-full border border-dashed`, with `transition-colors duration-700` |
| Ambient glow | `radial-gradient(ellipse at 50% 0%, …)` on the section background |
| Connected-node graph | DOM chips plus connector lines converging on a hub — not canvas |
| Floating UI mockups | Rounded cards, ~16–20px radius, heavy soft shadow, layered with offsets |
| Two-tone headline | Black first line, grey second line |
| Step counters | `01 / 03` above each row, with uppercase micro-labels |
| Status pills | A small `animate-pulse` dot beside the label |
| Row progress bars | Orange fill inside a light track |
| Page transitions | `kivo-page-in` / `kivo-page-out` keyframes, plus a full-screen WebGL veil that fades over `duration-700` |
| Float | A `kivo-float` keyframe on the layered cards |
| Everything else | CSS transitions at `duration-500`/`duration-700`, 94 of them running at once on the hero |

Worth saying plainly: **Kivo uses no animation library for any of this.** It is
canvas plus CSS transitions. The techniques in the brief — GSAP ScrollTrigger,
Framer Motion, Lottie — are not what the site is doing, so matching it did not
mean adding them. Everything below is built on the Web Animations API,
`IntersectionObserver`, canvas 2D and CSS, and the application still ships with
no runtime dependencies.

## What it was mapped onto

Each effect had to earn its place by carrying information. The rule: if an
animation would look the same whether the system was working or not, it did
not go in.

| Kivo effect | Here | Driven by |
|---|---|---|
| Dotted sphere | **The research orb** in the hero | `orbState()` — real `busy`, real queue. A still orb means nothing is running |
| Orbit rings | Three dashed rings around the orb; they turn only while work is in flight | the same state |
| Dot-field terrain | The ambient field behind the hero | painted once, drifts under CSS |
| Ambient glow | The wash behind the hero | static |
| Connected-node graph | **The pipeline rail** — nodes joined by edges, with a pulse travelling along an edge | `railEdges()` — an edge pulses only when a company has really reached the far side |
| Step counters | `01 / 06` above each rail node | `stepCounter()` |
| Row progress bars | Shortlist rows | `progressRatio()` — answered questions over the profile's own qualifier count, sent down from `/api/state` |
| Status pill dot | The chips that the live check confirmed working | `/api/selfcheck` |
| Page transitions | Switching review tabs | only on a real change of tab, not on every repaint |
| Float | The action-card icons | decorative, 6s |
| Floating mockups | Cards lift and lean towards the pointer | pointer position |
| Two-tone headline | Already here, as the amber `<em>` | — |
| Text masking | The headline arrives a word at a time from behind a clipped line | once, on load |
| Frosted panel | The masthead, which the page scrolls under | — |
| Hub graphic — chips converging on a centre | **The evidence graph** on every reviewed company | `evidenceGraph()` — one chip per question that got an answer, lines converging on the verdict they produced. The question that actually decided it is solid amber; an answer with no source behind it is dashed |
| SVG path drawing | Those converging lines draw themselves on | measured after layout, since they join real chip positions |
| Arc segments around the sphere | **The arc around the orb** | `pipelineProgress()` — how much of the shortlist is finished, counting ruled-out as finished |
| Analytics tiles counting up | The metrics strip | the real figure is written first, then counted up to; it is in the DOM from the start |
| Interactive light | A soft light follows the pointer across a card | one radial gradient, two custom properties |

## What was left out, and why

Kivo is a 25,703px marketing page whose job is to hold a stranger's attention.
This is a tool someone has open while deciding whether to email a company.
Those are opposite jobs, and some of its best effects would be actively bad
here:

- **Parallax scrolling** and **scroll-pinned scenes** — they make a page longer
  to read on purpose. A review queue should be shorter.
- **Horizontal scroll sections** — they hide things behind a gesture. Nothing
  waiting for your decision should be hidden behind a gesture.
- **Infinite marquees** — permanent movement next to text you are reading.
- **A full-screen WebGL veil between pages** — half a second of nothing, every
  time you switch tabs, on a page you switch tabs on constantly.
- **Lottie / GSAP / Framer Motion** — three dependencies and a build step for
  effects that Kivo itself does without.

## The rules it follows

- **Nothing animates that does not mean something.** The orb, the rail pulses
  and the progress bars are all reading real state. The float, the tilt and the
  headline are the only pure decoration, and they are all one-shot or idle.
- **Reduced motion stops everything.** `prefers-reduced-motion: reduce` zeroes
  every duration, hides the dot field, and turns off the reveal, the tilt, the
  magnetic pull and the tab cross-fade in JavaScript as well as CSS. The orb
  still draws — a still picture of the system's state is fine — it just does
  not turn. The page is fully usable with every animation switched off, which
  is the test of whether the motion was decoration or load-bearing.
- **An animation may never hide content.** The staggered reveal has a 1.2s
  safety net that shows everything regardless, so a observer that never fires
  cannot leave a card at `opacity: 0`.
- **The number is there before the animation is.** The metrics strip writes
  its real figures into the DOM first and only then counts up to them, so a
  screen reader, a reduced-motion setting or a half-finished count all leave
  the right number on screen. The same goes for the drawn lines, which snap
  to fully drawn if the observer never fires.
- **It has to be cheap.** One orb frame costs 0.193ms — 1.2% of a 60fps budget
  — and the orb drops to roughly 18fps when idle, stops when the tab is hidden,
  and stops when it scrolls out of view. The dot field is painted once per page
  load (0.17ms), and drifts with a composited transform rather than a repaint.
