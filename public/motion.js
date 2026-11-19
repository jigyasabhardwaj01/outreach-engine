// The motion layer: the drawing and the gestures, with no opinions of its own.
// What the orb should be doing lives in view.js; this only puts it on screen.
//
// Nothing here is a dependency. Kivo draws its sphere and its dot field in
// canvas and does the rest with CSS transitions, and so does this — a tool you
// keep open all day should not be downloading an animation runtime to tilt a
// card.

const motionOff = window.matchMedia('(prefers-reduced-motion: reduce)');

/** Does this person want movement? Asked every time, because it can change. */
export const reducedMotion = () => motionOff.matches;

/** Re-run something whenever that preference changes. */
export const onMotionPreference = (handler) => motionOff.addEventListener('change', handler);

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/** The page's own colours, so the canvas can never drift from the CSS. */
function token(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * Points spread evenly over a sphere.
 *
 * The obvious way — stepping through latitude and longitude — bunches them at
 * the poles. The golden angle gives an even covering, which is what makes the
 * surface read as a solid object rather than a wireframe globe.
 */
function spherePoints(count) {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const points = [];
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    points.push([Math.cos(theta) * radius, y, Math.sin(theta) * radius]);
  }
  return points;
}

/**
 * The research orb: a sphere of dots that turns while the system is working.
 *
 * It is the one piece of pure decoration on the page, and it earns its place
 * by being honest — it is driven by whether requests are actually in flight,
 * so a still orb means nothing is running and a bright one means something is.
 *
 * It stops completely when the tab is hidden, when it scrolls out of view, and
 * when the person has asked for less movement. An idle orb also runs at a
 * fraction of the frame rate: it is a tool you leave open, not a demo.
 */
export class ResearchOrb {
  constructor(canvas, { points = 420 } = {}) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.points = spherePoints(points);
    this.spin = 0;
    this.tilt = -0.42;
    this.shown = 0.12;
    this.target = 0.12;
    this.frame = null;
    this.lastDrawn = 0;
    this.visible = true;

    this.resize();
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);

    // Offscreen and hidden tabs cost nothing.
    this.inView = new IntersectionObserver(([entry]) => {
      this.visible = entry.isIntersecting;
      this.visible ? this.start() : this.stop();
    });
    this.inView.observe(canvas);

    document.addEventListener('visibilitychange', () => (document.hidden ? this.stop() : this.start()));
    onMotionPreference(() => (reducedMotion() ? (this.stop(), this.draw(1)) : this.start()));
  }

  resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const box = this.canvas.getBoundingClientRect();
    const size = Math.max(1, Math.round(Math.min(box.width, box.height)));
    this.canvas.width = size * ratio;
    this.canvas.height = size * ratio;
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.size = size;
    this.draw(1);
  }

  /** Aim for a new intensity. The orb eases there rather than jumping. */
  setIntensity(intensity) {
    this.target = clamp(Number(intensity) || 0, 0, 1);
    if (reducedMotion()) this.draw(1);
    else this.start();
  }

  start() {
    if (this.frame !== null || reducedMotion() || document.hidden || !this.visible) return;
    const step = (now) => {
      this.frame = requestAnimationFrame(step);
      // An idle orb turns slowly and need not be redrawn sixty times a second.
      const interval = this.shown > 0.5 ? 0 : 55;
      if (now - this.lastDrawn < interval) return;
      const elapsed = this.lastDrawn ? Math.min(now - this.lastDrawn, 100) : 16;
      this.lastDrawn = now;
      this.advance(elapsed);
    };
    this.frame = requestAnimationFrame(step);
  }

  stop() {
    if (this.frame === null) return;
    cancelAnimationFrame(this.frame);
    this.frame = null;
    this.lastDrawn = 0;
  }

  advance(elapsed) {
    this.shown += (this.target - this.shown) * Math.min(1, elapsed / 420);
    // Idle is a drift; working is a turn you can see.
    this.spin += (0.00012 + this.shown * 0.00105) * elapsed;
    this.draw(this.shown);
  }

  draw(intensity) {
    const { context, size } = this;
    if (!size) return;

    const amber = token('--amber', '#e8701a');
    const soft = token('--soft', '#6d6269');
    const middle = size / 2;
    const radius = size * 0.38;
    const sin = Math.sin(this.spin);
    const cos = Math.cos(this.spin);
    const tiltSin = Math.sin(this.tilt);
    const tiltCos = Math.cos(this.tilt);

    context.clearRect(0, 0, size, size);

    for (const [x, y, z] of this.points) {
      // Turn around the vertical axis, then lean the whole thing towards us.
      const spunX = x * cos - z * sin;
      const spunZ = x * sin + z * cos;
      const leanedY = y * tiltCos - spunZ * tiltSin;
      const depth = y * tiltSin + spunZ * tiltCos;

      // Perspective: dots at the back sit closer in and shrink.
      const scale = 1 / (1.9 - depth * 0.42);
      const screenX = middle + spunX * radius * scale * 1.9;
      const screenY = middle + leanedY * radius * scale * 1.9;

      const facing = (depth + 1) / 2;
      const alpha = (0.07 + facing * 0.62) * (0.35 + intensity * 0.65);
      const dot = (0.5 + facing * 1.05) * (0.85 + intensity * 0.3);

      context.beginPath();
      context.fillStyle = intensity > 0.25 ? amber : soft;
      context.globalAlpha = alpha;
      context.arc(screenX, screenY, dot, 0, Math.PI * 2);
      context.fill();
    }
    context.globalAlpha = 1;
  }

  destroy() {
    this.stop();
    this.observer.disconnect();
    this.inView.disconnect();
  }
}

/**
 * The ambient dot field behind the hero, the way Kivo's terrain reads: denser
 * and brighter where the page is busiest, fading out at the edges.
 *
 * Drawn once and left alone. The drifting is a CSS transform on the canvas,
 * which the compositor handles — a per-frame redraw of a full-width field is
 * real battery for something nobody is meant to look at directly.
 */
export function paintDotField(canvas) {
  const context = canvas.getContext('2d');
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const box = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(box.width));
  const height = Math.max(1, Math.round(box.height));

  canvas.width = width * ratio;
  canvas.height = height * ratio;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  const amber = token('--amber', '#e8701a');
  const gap = 26;

  for (let x = gap / 2; x < width; x += gap) {
    for (let y = gap / 2; y < height; y += gap) {
      // A couple of sine waves crossing: enough to look like terrain, cheap
      // enough to compute for a few hundred points.
      const wave = Math.sin(x / 150) * Math.cos(y / 90) * 0.5 + 0.5;
      const fromCentre = Math.abs(x - width / 2) / (width / 2);
      const down = y / height;
      const alpha = wave * 0.3 * (1 - fromCentre * 0.85) * (1 - down * 0.5);
      if (alpha < 0.012) continue;

      context.beginPath();
      context.fillStyle = amber;
      context.globalAlpha = alpha;
      context.arc(x, y, 1 + wave * 0.9, 0, Math.PI * 2);
      context.fill();
    }
  }
  context.globalAlpha = 1;
}

/**
 * Reveal things as they arrive: a short rise and fade, staggered down the
 * list so the eye has an order to follow.
 *
 * Anything already on screen when the page loads is revealed at once rather
 * than waiting to be scrolled to, which is the usual way this goes wrong.
 */
/** @param {Iterable<HTMLElement>} nodes */
export function revealOnEntry(nodes, { stagger = 55, max = 10 } = {}) {
  const list = [...nodes];
  if (reducedMotion()) {
    for (const node of list) node.classList.add('shown');
    return;
  }

  const observer = new IntersectionObserver((entries, self) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const target = /** @type {HTMLElement} */ (entry.target);
      const index = Number(target.dataset.revealIndex ?? 0);
      target.style.transitionDelay = `${Math.min(index, max) * stagger}ms`;
      target.classList.add('shown');
      self.unobserve(target);
    }
  }, { rootMargin: '0px 0px -40px 0px' });

  list.forEach((node, index) => {
    node.dataset.revealIndex = String(index);
    node.classList.add('reveal');
    observer.observe(node);
  });

  // An animation must never be the reason something cannot be read. If the
  // observer has not got to a card shortly after it was built — an observer
  // that never fires, a container that was hidden at the time, a list nobody
  // scrolled — show it anyway and give up the effect.
  setTimeout(() => {
    for (const node of list) node.classList.add('shown');
    observer.disconnect();
  }, 1200);
}

/**
 * The card leans towards the pointer. Small numbers on purpose: at the angles
 * a marketing page uses, text stops being comfortable to read, and these are
 * cards you actually read.
 */
export function tiltOnHover(node, { degrees = 3.2 } = {}) {
  if (reducedMotion() || !window.matchMedia('(hover: hover)').matches) return;

  let frame = null;
  const move = (event) => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      const box = node.getBoundingClientRect();
      const x = (event.clientX - box.left) / box.width - 0.5;
      const y = (event.clientY - box.top) / box.height - 0.5;
      node.style.transform = `perspective(900px) rotateX(${-y * degrees}deg) rotateY(${x * degrees}deg) translateZ(0)`;
    });
  };

  node.addEventListener('pointermove', move);
  node.addEventListener('pointerleave', () => {
    if (frame) cancelAnimationFrame(frame);
    frame = null;
    node.style.transform = '';
  });
}

/** A button that leans towards the pointer as it gets close. */
export function magnetic(node, { pull = 0.22, radius = 56 } = {}) {
  if (reducedMotion() || !window.matchMedia('(hover: hover)').matches) return;

  node.addEventListener('pointermove', (event) => {
    const box = node.getBoundingClientRect();
    const x = event.clientX - (box.left + box.width / 2);
    const y = event.clientY - (box.top + box.height / 2);
    if (Math.hypot(x, y) > radius + Math.max(box.width, box.height) / 2) return;
    node.style.transform = `translate(${x * pull}px, ${y * pull}px)`;
  });
  node.addEventListener('pointerleave', () => { node.style.transform = ''; });
}

/**
 * Swap the contents of a panel with a short cross-fade, the way Kivo moves
 * between pages. Skipped entirely under reduced motion, and skipped when the
 * panel is empty, so the first paint is not a fade from nothing.
 */
export function swap(panel, paint) {
  if (reducedMotion() || !panel.childElementCount) return paint();

  panel.classList.add('leaving');
  const done = () => {
    panel.classList.remove('leaving');
    paint();
    panel.classList.add('entering');
    requestAnimationFrame(() => panel.classList.remove('entering'));
  };
  // The class drives a 110ms transition; this is the same duration, not a guess.
  setTimeout(done, 110);
}

/**
 * Count a number up to its value the first time it is seen, the way Kivo's
 * analytics tiles do.
 *
 * The number is written into the element before any of this runs, so the real
 * figure is in the DOM from the start: if the animation never happens — no
 * observer, reduced motion, a screen reader reading straight through — the
 * right number is already there to be read.
 */
export function countUp(node, { duration = 900 } = {}) {
  const final = node.textContent ?? '';
  const match = final.match(/-?[\d.]+/);
  if (!match || reducedMotion()) return;

  const target = Number(match[0]);
  if (!Number.isFinite(target) || target === 0) return;
  const decimals = (match[0].split('.')[1] ?? '').length;

  const observer = new IntersectionObserver(([entry], self) => {
    if (!entry.isIntersecting) return;
    self.disconnect();

    const started = performance.now();
    const step = (now) => {
      const through = Math.min(1, (now - started) / duration);
      // Ease out: most of the distance early, so it settles rather than stops.
      const eased = 1 - Math.pow(1 - through, 3);
      const value = (target * eased).toFixed(decimals);
      node.textContent = final.replace(match[0], value);
      if (through < 1) requestAnimationFrame(step);
      else node.textContent = final;
    };
    requestAnimationFrame(step);
  });

  observer.observe(node);
  // The real number must never be left behind by a half-finished count.
  setTimeout(() => { observer.disconnect(); node.textContent = final; }, duration + 2500);
}

/**
 * A soft light that follows the pointer across a card — Kivo's interactive
 * light, which it does with a radial gradient rather than anything clever.
 *
 * Two custom properties and one composited layer; the gradient itself lives
 * in the stylesheet.
 */
export function spotlight(node) {
  if (reducedMotion() || !window.matchMedia('(hover: hover)').matches) return;

  let frame = null;
  node.addEventListener('pointermove', (event) => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      const box = node.getBoundingClientRect();
      node.style.setProperty('--mx', `${event.clientX - box.left}px`);
      node.style.setProperty('--my', `${event.clientY - box.top}px`);
    });
  });
  node.addEventListener('pointerenter', () => node.classList.add('lit'));
  node.addEventListener('pointerleave', () => {
    if (frame) cancelAnimationFrame(frame);
    frame = null;
    node.classList.remove('lit');
  });
}

/**
 * Draw an SVG path on, rather than having it appear.
 *
 * The trick is the oldest one in SVG: set the dash pattern to the length of
 * the line and offset it by the same amount, so the line is entirely in the
 * gap, then animate the offset to nothing.
 */
export function drawPath(path, { duration = 620, delay = 0 } = {}) {
  const length = path.getTotalLength?.() ?? 0;
  if (!length || reducedMotion()) return;

  path.style.strokeDasharray = `${length}`;
  path.style.strokeDashoffset = `${length}`;

  const observer = new IntersectionObserver(([entry], self) => {
    if (!entry.isIntersecting) return;
    self.disconnect();
    path.style.transition = `stroke-dashoffset ${duration}ms ${delay}ms cubic-bezier(.22,.61,.36,1)`;
    requestAnimationFrame(() => { path.style.strokeDashoffset = '0'; });
  });
  observer.observe(path);

  // Never leave a line half-drawn if the observer does not fire.
  setTimeout(() => { observer.disconnect(); path.style.strokeDashoffset = '0'; }, duration + delay + 2000);
}

/**
 * One scroll driver for the whole page.
 *
 * Every scroll-linked effect reads from this, because a page with four
 * separate scroll listeners does four times the work for one gesture. It is
 * passive and throttled to a frame, so it can never hold up the scroll
 * itself — the thing that makes parallax feel broken when it is done badly.
 */
export function onScroll(handler) {
  if (reducedMotion()) return () => {};

  let frame = null;
  const run = () => {
    frame = null;
    handler(window.scrollY);
  };
  const schedule = () => {
    if (frame === null) frame = requestAnimationFrame(run);
  };

  window.addEventListener('scroll', schedule, { passive: true });
  run();
  return () => {
    window.removeEventListener('scroll', schedule);
    if (frame !== null) cancelAnimationFrame(frame);
  };
}

/**
 * Parallax: layers that move at different rates as the page scrolls, which
 * is what reads as depth.
 *
 * The rates are small. At the depth a marketing page uses, the background
 * slides visibly behind text you are trying to read, and this is a page
 * people read.
 */
export function parallax(layers) {
  return onScroll((y) => {
    for (const { node, rate } of layers) {
      node.style.transform = `translate3d(0, ${(y * rate).toFixed(1)}px, 0)`;
    }
  });
}

/**
 * A marquee that loops on its own and is also nudged along by scrolling —
 * Kivo's two horizontal techniques on one strip of real content.
 *
 * The children are duplicated once so the loop has somewhere to come back
 * from. It pauses on hover so you can read it, and when it scrolls out of
 * view so it is not animating off-screen.
 */
export function marquee(track, { scrollRate = 0.12 } = {}) {
  const items = [...track.children];
  if (!items.length || reducedMotion()) return () => {};

  // The copy is for the eye only; a screen reader should read the list once.
  for (const item of items) {
    const copy = item.cloneNode(true);
    copy.setAttribute('aria-hidden', 'true');
    track.append(copy);
  }
  track.classList.add('rolling');

  let visible = true;
  const watcher = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    track.style.animationPlayState = visible ? '' : 'paused';
  });
  watcher.observe(track);

  const stop = onScroll((y) => {
    if (!visible) return;
    track.style.setProperty('--nudge', `${(-y * scrollRate).toFixed(1)}px`);
  });

  return () => {
    stop();
    watcher.disconnect();
  };
}
