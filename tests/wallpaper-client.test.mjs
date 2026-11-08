import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../public/scripts/pages/home.js', import.meta.url), 'utf8');
const scheduling = source.slice(source.indexOf('function removeWallpaper()'), source.indexOf('function updateFooter('));
const loading = source.slice(source.indexOf('function loadWallpaper('), source.indexOf('function startClockUpdates('));

function harness() {
  const images = [];
  const timers = new Map();
  const idle = [];
  const classes = new Set();
  const style = { backgroundImage: '', removeProperty(name) { delete this[name]; } };
  const warnings = [];
  let nextTimer = 0;
  const app = vm.createContext({
    wallpaperContainer: {
      style,
      classList: { add: name => classes.add(name), remove: name => classes.delete(name) },
    },
    Image: class {
      constructor() { images.push(this); }
      removeAttribute(name) { delete this[name]; }
    },
    window: {
      setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
      clearTimeout(id) { timers.delete(id); },
    },
    console: { warn(message) { warnings.push(message); }, error() {} },
    scheduleNonCriticalTask(callback) { idle.push(callback); },
  });
  vm.runInContext(`let wallpaperTaskToken = 0; let cancelWallpaperLoad = null;\n${scheduling}\n${loading}`, app);
  return {
    app, images, timers, classes, style, warnings,
    update(enabled, url) { app.scheduleWallpaperUpdate(enabled, url); while (idle.length) idle.shift()(); },
    fireTimer() { const [id, callback] = timers.entries().next().value; timers.delete(id); callback(); },
  };
}

test('default and saved legacy wallpaper use the same-origin daily endpoint', () => {
  for (const url of [undefined, '', '  https://bing.img.run/uhd.php  ', '/api/wallpaper']) {
    const h = harness();
    h.update(true, url);
    assert.equal(h.images[0].src, '/api/wallpaper');
    h.images[0].onload();
    assert.equal(h.style.backgroundImage, 'url("/api/wallpaper")');
    assert.ok(h.classes.has('loaded'));
    assert.equal(h.timers.size, 0);
  }
});

test('disable and re-enable remove stale inline opacity and display the new image', () => {
  const h = harness();
  h.style.opacity = '0';
  h.update(false);
  assert.equal(h.style.opacity, undefined);
  h.update(true, 'https://example.com/wallpaper.jpg');
  h.images[0].onload();
  assert.ok(h.classes.has('loaded'));
  assert.equal(h.style.opacity, undefined);
});

test('an old image cannot replace a newer wallpaper', () => {
  const h = harness();
  h.update(true, 'https://example.com/old.jpg');
  const oldSuccess = h.images[0].onload;
  h.update(true, 'https://example.com/new.jpg');
  h.images[1].onload();
  oldSuccess();
  assert.equal(h.style.backgroundImage, 'url("https://example.com/new.jpg")');
  assert.equal(h.timers.size, 0);
});

test('disabled wallpaper rejects both late success and late failure', () => {
  for (const event of ['onload', 'onerror']) {
    const h = harness();
    h.update(true, 'https://example.com/slow.jpg');
    const oldCallback = h.images[0][event];
    h.update(false);
    oldCallback();
    assert.equal(h.images.length, 1);
    assert.equal(h.style.backgroundImage, '');
    assert.equal(h.classes.has('loaded'), false);
    assert.equal(h.timers.size, 0);
  }
});

test('custom image failure retries the default only once and keeps the local fallback', () => {
  const h = harness();
  h.update(true, 'https://example.com/broken.jpg');
  assert.equal(h.style.backgroundImage, 'url("/images/wallpaper-fallback.svg")');
  h.images[0].onerror();
  assert.equal(h.images[1].src, '/api/wallpaper');
  h.images[1].onerror();
  h.fireTimer();
  assert.equal(h.images[2].src, '/api/wallpaper');
  h.images[2].onerror();
  assert.equal(h.images.length, 3);
  assert.equal(h.timers.size, 0);
  assert.equal(h.classes.has('loaded'), true);
  assert.equal(h.style.backgroundImage, 'url("/images/wallpaper-fallback.svg")');
});

test('timeout detaches stale callbacks and falls back without late-image overwrite', () => {
  const h = harness();
  h.update(true, 'https://example.com/hanging.jpg');
  const lateSuccess = h.images[0].onload;
  h.fireTimer();
  assert.equal(h.images[0].onload, null);
  assert.equal(h.images[0].src, undefined);
  assert.equal(h.images[1].src, '/api/wallpaper');
  h.images[1].onload();
  lateSuccess();
  assert.equal(h.style.backgroundImage, 'url("/api/wallpaper")');
  assert.equal(h.timers.size, 0);
  assert.match(h.warnings[0], /超时/);
});

test('turning wallpaper off cancels both active downloads and pending retries', () => {
  const h = harness();
  h.update(true, '/api/wallpaper');
  h.update(false);
  assert.equal(h.images[0].src, undefined);
  assert.equal(h.images[0].onload, null);
  assert.equal(h.timers.size, 0);
  h.update(true, '/api/wallpaper');
  h.images[1].onerror();
  const retry = [...h.timers.values()][0];
  h.update(false);
  retry();
  assert.equal(h.images.length, 2);
  assert.equal(h.timers.size, 0);
  assert.equal(h.style.backgroundImage, '');
});

test('refresh failures preserve a previously loaded wallpaper', () => {
  const h = harness();
  h.update(true, 'https://example.com/good.jpg');
  h.images[0].onload();
  h.update(true, '/api/wallpaper');
  h.images[1].onerror();
  h.fireTimer();
  h.images[2].onerror();
  assert.equal(h.style.backgroundImage, 'url("https://example.com/good.jpg")');
});

test('a new wallpaper setting cancels an old scheduled retry', () => {
  const h = harness();
  h.update(true, '/api/wallpaper');
  h.images[0].onerror();
  const oldRetry = [...h.timers.values()][0];
  h.update(true, 'https://example.com/new.jpg');
  h.images[1].onload();
  oldRetry();
  assert.equal(h.images.length, 2);
  assert.equal(h.style.backgroundImage, 'url("https://example.com/new.jpg")');
  assert.equal(h.timers.size, 0);
});
