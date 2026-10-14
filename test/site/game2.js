import * as THREE from './three.module.js';
class Player {
  constructor(id, scene) {
    this.id = id; this.mesh = new THREE.Group(); this.mesh.position.set(0, 0, 0);
    const mat = new THREE.MeshStandardMaterial({ color: 0x5522aa });
    this.head = new THREE.Mesh(new THREE.BoxGeometry(.3, .3, .3), mat); this.head.position.y = 1.6;
    // Arms pivot at the shoulder and hang down -Y, like a typical avatar rig.
    const armGeo = new THREE.BoxGeometry(.12, .6, .12); armGeo.translate(0, -0.3, 0);
    this.leftArm = new THREE.Mesh(armGeo, mat); this.leftArm.position.set(-.25, 1.4, 0);
    this.rightArm = new THREE.Mesh(armGeo, mat); this.rightArm.position.set(.25, 1.4, 0);
    // Torso + legs + clothing. Arms hang off the torso, as in many rigs.
    this.torso = new THREE.Mesh(new THREE.BoxGeometry(.5, .6, .25), mat); this.torso.position.y = 1.1;
    this.shirt = new THREE.Mesh(new THREE.BoxGeometry(.55, .5, .3), new THREE.MeshStandardMaterial({ color: 0x2266ff })); this.torso.add(this.shirt);
    const legGeo = new THREE.BoxGeometry(.15, .8, .15); legGeo.translate(0, -0.4, 0);
    this.leftLeg = new THREE.Mesh(legGeo, mat); this.leftLeg.position.set(-.12, .8, 0);
    this.rightLeg = new THREE.Mesh(legGeo, mat); this.rightLeg.position.set(.12, .8, 0);
    this.shoe = new THREE.Mesh(new THREE.BoxGeometry(.18, .1, .25), mat); this.shoe.position.y = -0.78; this.leftLeg.add(this.shoe);
    this.hat = new THREE.Mesh(new THREE.BoxGeometry(.35, .1, .35), mat); this.hat.position.y = 0.2; this.head.add(this.hat);
    // arms parented to the torso (positions relative to torso)
    this.leftArm.position.set(-.25, .3, 0); this.rightArm.position.set(.25, .3, 0);
    this.torso.add(this.leftArm, this.rightArm);
    // Every avatar has a black back-faced outline shell around its body (the "inverted black box" look).
    this.outline = new THREE.Mesh(new THREE.BoxGeometry(.6, 1.9, .5), new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide }));
    this.outline.position.y = 0.95;
    this.mesh.add(this.head, this.torso, this.leftLeg, this.rightLeg, this.outline); scene.add(this.mesh);
  }
  isLocalPlayer() { return this.id === 'me'; }
}
class Game {
  constructor() {
    const renderer = new THREE.WebGLRenderer(); renderer.setSize(innerWidth, innerHeight);
    document.getElementById('game').appendChild(renderer.domElement);
    this.renderer = renderer; this.scene = new THREE.Scene();
    if (location.search.includes('textured')) { const c = document.createElement('canvas'); c.width = c.height = 4; this.scene.background = new THREE.CanvasTexture(c); }
    else this.scene.background = new THREE.Color(0x88bbee); // flat-coloured, no textures anywhere
    // Power-up with an inverted-hull outline (back faces, black) - renders as a black box in VR.
    this.powerup = new THREE.Mesh(new THREE.BoxGeometry(.4, .4, .4), new THREE.MeshBasicMaterial({ color: 0xffcc00 }));
    this.powerup.position.set(1, 1, -2);
    this.powerupOutline = new THREE.Mesh(new THREE.BoxGeometry(.4, .4, .4), new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide }));
    this.powerupOutline.scale.setScalar(1.15); this.powerup.add(this.powerupOutline); this.scene.add(this.powerup);
    // Menu / between-rounds: separate scene and camera, no avatar.
    this.menuScene = new THREE.Scene(); this.menuScene.background = new THREE.Color(0x222244);
    this.menuScene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xff00ff })));
    this.menuCamera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 100); this.menuCamera.position.set(3, 2, 6); this.menuCamera.lookAt(0, 0, 0);
    this.requireLock = location.search.includes('lock'); this.mode = 'play'; this.rebuildAt = -1; this.thirdPerson = location.search.includes('third');
    this.camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 500);
    this.players = new Map(); this.localPlayerId = 'me';
    this.scene.add(new THREE.Mesh(new THREE.BoxGeometry(50, .1, 50), new THREE.MeshBasicMaterial({ color: 0x228822 })));
    this.players.set('me', new Player('me', this.scene));
    const other = new Player('bot', this.scene); other.mesh.position.set(3, 0, -4); this.players.set('bot', other);
    this.yaw = 0; this.pitch = 0; this.sens = 0.0031; this.keys = new Set(); this.paused = false; this.frames = 0; this.respawns = 0;
    this.lockEl = () => (location.search.includes('lockbody') ? document.body : this.renderer.domElement);
    const typing = () => { const a = document.activeElement; return !!a && (a.tagName === 'INPUT' && a.type === 'text'); };
    document.addEventListener('mousemove', (e) => { if (this.paused || typing()) return; if (this.requireLock && document.pointerLockElement !== this.lockEl()) return; this.yaw -= e.movementX * this.sens; this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch - e.movementY * this.sens)); });
    window.addEventListener('keydown', (e) => { if (!this.paused && !typing()) this.keys.add(e.code); });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    // The bug the user hit: losing focus clears input and ignores it until the window is focused again.
    window.addEventListener('blur', () => { this.paused = true; this.keys.clear(); });
    window.addEventListener('focus', () => { this.paused = false; });
    document.getElementById('respawn').addEventListener('click', () => this.respawns++);
  }
  rebuildPlayers() {
    // What some games do on respawn / resync: throw away the player objects and the Map, make new ones.
    const old = this.players.get('me');
    this.scene.remove(old.mesh);
    const fresh = new Player('me', this.scene);
    fresh.mesh.position.copy(old.mesh.position);
    this.players = new Map([['me', fresh]]);
  }
  frame = () => {
    if (location.search.includes('norender') && !window.__started) { requestAnimationFrame(this.frame); return; } // main menu: no 3D yet
    if (location.search.includes('emptymenu') && !window.__started) { // main menu drawn as a sky colour only (no meshes)
      if (!this.emptyScene) { this.emptyScene = new THREE.Scene(); this.emptyScene.background = new THREE.Color(0x88bbee); }
      this.renderer.render(this.emptyScene, this.menuCamera); requestAnimationFrame(this.frame); return;
    }
    if (location.search.includes('rebuild') && this.frames === this.rebuildAt) this.rebuildPlayers();
    const me = this.players.get('me');
    me.mesh.rotation.y = this.yaw;
    if (this.keys.has('KeyW')) me.mesh.translateZ(-0.08);
    this.camera.position.copy(me.mesh.localToWorld(new THREE.Vector3(0, 1.6, 0)));
    me.isRagdollState = !!this.ragdoll;
    if (this.ragdoll) { me.head.position.set(Math.sin(this.frames) * 0.5, 0.4, 0.6); this.camera.position.add(new THREE.Vector3(0, 2, 6)); }
    else if (!this.glitchNext) me.head.position.set(0, 1.6, 0);
    if (this.thirdPerson) this.camera.position.add(new THREE.Vector3(Math.sin(this.yaw) * 8, 2, Math.cos(this.yaw) * 8));
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    if (this.glitchNext) { this.glitchNext = false; me.head.position.set(NaN, NaN, NaN); me.head.updateMatrixWorld(); }
    if (this.mode === 'menu') this.renderer.render(this.menuScene, this.menuCamera);
    else this.renderer.render(this.scene, this.camera);
    if (this.lateClear) this.renderer.clear(); // a game that clears after drawing
    this.frames++; requestAnimationFrame(this.frame);
  };
}
window.THREE_REF = THREE;
window.game = new Game(); requestAnimationFrame(window.game.frame);
if (location.search.includes('layer1')) {
  // Camera and world on layer 1 only: objects left on layer 0 are invisible to this camera.
  window.game.camera.layers.set(1);
  window.game.scene.traverse((o) => o.layers.set(1));
}
