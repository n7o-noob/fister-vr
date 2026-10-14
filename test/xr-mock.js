// Minimal fake WebXR device: enough of the API for the mod and three.js's WebXRManager to run end to end.
(() => {
  const persp = (fov, aspect, near, far) => { const f = 1 / Math.tan(fov / 2), nf = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]); };
  const translation = (x, y, z) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
  const xform = (m) => ({ matrix: m, position: { x: m[12], y: m[13], z: m[14], w: 1 }, orientation: { x: 0, y: 0, z: 0, w: 1 },
    get inverse() { return { matrix: translation(-m[12], -m[13], -m[14]) }; } });
  const rayMatrix = (o, d) => {
    const len = Math.hypot(...d); const z = [-d[0] / len, -d[1] / len, -d[2] / len];
    let x = [z[2], 0, -z[0]]; const xl = Math.hypot(...x) || 1; x = x.map(v => v / xl);
    const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    return new Float32Array([...x, 0, ...y, 0, ...z, 0, o[0], o[1], o[2], 1]);
  };
  const pad = () => ({ buttons: Array.from({ length: 6 }, () => ({ pressed: false, touched: false, value: 0 })), axes: [0, 0, 0, 0], mapping: 'xr-standard' });
  const sources = ['right', 'left'].map((hand) => ({ handedness: hand, targetRayMode: 'tracked-pointer', profiles: [], gamepad: pad(),
    targetRaySpace: { hand, kind: 'ray' }, gripSpace: { hand, kind: 'grip' } }));
  const rays = { right: rayMatrix([0.2, 1.2, -0.3], [0, 0, -1]), left: rayMatrix([-0.2, 1.2, -0.3], [0, 0, -1]) };
  const head = translation(0, 1.6, 0);
  const proj = persp(Math.PI / 2, 1, 0.05, 1000);
  window.__xrMock = {
    sessions: 0, frames: 0,
    setRay(hand, o, d) { rays[hand] = rayMatrix(o, d); },
    setAxes(hand, axes) { const s = sources.find(x => x.handedness === hand); axes.forEach((v, i) => { s.gamepad.axes[i] = v; }); },
    press(hand, index, on) { const s = sources.find(x => x.handedness === hand); s.gamepad.buttons[index].pressed = on; s.gamepad.buttons[index].value = on ? 1 : 0; if (index === 0 && window.__xrMock.session) { const e = new Event(on ? 'selectstart' : 'selectend'); e.inputSource = s; window.__xrMock.session.dispatchEvent(e); if (!on) { const e2 = new Event('select'); e2.inputSource = s; window.__xrMock.session.dispatchEvent(e2); } } },
  };
  class FakeLayer {
    constructor(session, gl) { this.gl = gl; this.framebuffer = null; this.framebufferWidth = gl.drawingBufferWidth; this.framebufferHeight = gl.drawingBufferHeight; this.ignoreDepthValues = false; this.antialias = true; session.__layers.push(this); }
    getViewport(view) { const w = this.framebufferWidth / 2; return { x: view.eye === 'left' ? 0 : w, y: 0, width: w, height: this.framebufferHeight }; }
  }
  window.XRWebGLLayer = FakeLayer;
  for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) if (C) C.prototype.makeXRCompatible = () => Promise.resolve();
  class FakeSession extends EventTarget {
    constructor() { super(); this.renderState = { baseLayer: null, depthNear: 0.1, depthFar: 1000 }; this.inputSources = sources; this.enabledFeatures = ['local']; this.environmentBlendMode = 'opaque'; this.visibilityState = 'visible'; this.__layers = []; this.__ended = false;
      setTimeout(() => { const e = new Event('inputsourceschange'); e.added = sources; e.removed = []; this.dispatchEvent(e); }, 30); }
    updateRenderState(s) { Object.assign(this.renderState, s); return Promise.resolve(); }
    requestReferenceSpace() { return Promise.resolve({ getOffsetReferenceSpace() { return this; }, addEventListener() {} }); }
    requestAnimationFrame(cb) { return setTimeout(() => { if (this.__ended) return; window.__xrMock.frames++; cb(performance.now(), this.__frame()); }, 14); }
    cancelAnimationFrame(id) { clearTimeout(id); }
    end() { if (this.__ended) return Promise.resolve(); this.__ended = true; this.dispatchEvent(new Event('end')); return Promise.resolve(); }
    __frame() {
      const session = this;
      const view = (eye, dx) => ({ eye, projectionMatrix: proj, transform: xform(translation(dx, 1.6, 0)), recommendedViewportScale: null, requestViewportScale() {} });
      return { session,
        getViewerPose() { return { transform: xform(head), views: [view('left', -0.032), view('right', 0.032)], emulatedPosition: false }; },
        getPose(space) { if (!space || !space.hand) return null; return { transform: xform(rays[space.hand]), emulatedPosition: false }; },
      };
    }
  }
  Object.defineProperty(navigator, 'xr', { configurable: true, value: {
    isSessionSupported: () => Promise.resolve(true),
    requestSession: () => { window.__xrMock.sessions++; window.__xrMock.session = new FakeSession(); return Promise.resolve(window.__xrMock.session); },
    addEventListener() {}, removeEventListener() {},
  } });
})();
