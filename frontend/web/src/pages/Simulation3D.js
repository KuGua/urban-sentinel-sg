import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import './Simulation3D.css';

const CAMERA_PRESETS = [
  { id: 'west-wall', label: 'West Wall Cam', position: [-23, 5.2, 0], lookAt: [0, 1.5, 0] },
  { id: 'east-wall', label: 'East Wall Cam', position: [23, 5.0, -1], lookAt: [0, 1.5, 0] },
  { id: 'north-wall', label: 'North Wall Cam', position: [1, 5.4, 30], lookAt: [0, 1.5, 0] },
  { id: 'south-wall', label: 'South Wall Cam', position: [-2, 5.1, -30], lookAt: [0, 1.5, 0] }
];

const WALK_NODES = [
  new THREE.Vector3(0, 0, -26),
  new THREE.Vector3(0, 0, -14),
  new THREE.Vector3(0, 0, -4),
  new THREE.Vector3(0, 0, 6),
  new THREE.Vector3(0, 0, 16),
  new THREE.Vector3(0, 0, 26),
  new THREE.Vector3(-18, 0, 16),
  new THREE.Vector3(-8, 0, 16),
  new THREE.Vector3(8, 0, 16),
  new THREE.Vector3(18, 0, 16),
  new THREE.Vector3(-18, 0, -16),
  new THREE.Vector3(-8, 0, -16),
  new THREE.Vector3(8, 0, -16),
  new THREE.Vector3(18, 0, -16)
];

const WALK_LINKS = {
  0: [1], 1: [0, 2], 2: [1, 3, 11, 12], 3: [2, 4, 7, 8], 4: [3, 5], 5: [4],
  6: [7], 7: [6, 3, 8], 8: [7, 3, 9], 9: [8],
  10: [11], 11: [10, 2, 12], 12: [11, 2, 13], 13: [12]
};

const rand = (min, max) => Math.random() * (max - min) + min;

function createIIntersection(scene) {
  scene.background = new THREE.Color(0x111d29);
  scene.fog = new THREE.Fog(0x111d29, 50, 130);

  const hemi = new THREE.HemisphereLight(0xcfeeff, 0x25384a, 1.0);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xffffff, 0.95);
  sun.position.set(34, 52, 22);
  scene.add(sun);

  const fill = new THREE.DirectionalLight(0x8db2c8, 0.42);
  fill.position.set(-24, 16, -18);
  scene.add(fill);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(180, 180),
    new THREE.MeshStandardMaterial({ color: 0x344a58, roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const asphalt = new THREE.MeshStandardMaterial({ color: 0x232b33, roughness: 0.94 });
  const roads = [
    { size: [16, 58], pos: [0, 0.02, 0] },
    { size: [46, 16], pos: [0, 0.02, 16] },
    { size: [46, 16], pos: [0, 0.02, -16] }
  ];
  for (const road of roads) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(road.size[0], road.size[1]), asphalt);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(...road.pos);
    scene.add(mesh);
  }

  const curbMat = new THREE.MeshStandardMaterial({ color: 0x9ba6ad, roughness: 0.74 });
  const curbs = [
    { size: [0.8, 0.24, 58], pos: [-8.35, 0.12, 0] },
    { size: [0.8, 0.24, 58], pos: [8.35, 0.12, 0] },
    { size: [46, 0.24, 0.8], pos: [0, 0.12, 24.35] },
    { size: [46, 0.24, 0.8], pos: [0, 0.12, 7.65] },
    { size: [46, 0.24, 0.8], pos: [0, 0.12, -7.65] },
    { size: [46, 0.24, 0.8], pos: [0, 0.12, -24.35] }
  ];
  for (const curb of curbs) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...curb.size), curbMat);
    mesh.position.set(...curb.pos);
    scene.add(mesh);
  }

  const wallMat = new THREE.MeshStandardMaterial({ color: 0x5d7180, roughness: 0.84 });
  const walls = [
    { size: [1.3, 6.0, 62], pos: [-26, 3.0, 0] },
    { size: [1.3, 6.0, 62], pos: [26, 3.0, 0] },
    { size: [54, 6.0, 1.3], pos: [0, 3.0, 34] },
    { size: [54, 6.0, 1.3], pos: [0, 3.0, -34] }
  ];
  for (const wall of walls) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...wall.size), wallMat);
    mesh.position.set(...wall.pos);
    scene.add(mesh);
  }

  const storefronts = [
    { name: 'Mini Mart', color: 0xffc870, pos: [-17, 2.2, 31.4], w: 8.0 },
    { name: 'Coffee Hub', color: 0x7dd1ff, pos: [-2, 2.2, 31.4], w: 9.5 },
    { name: 'Book Nook', color: 0xb7f0a4, pos: [13, 2.2, 31.4], w: 8.5 },
    { name: 'Clinic', color: 0xffb6c8, pos: [-12, 2.2, -31.4], w: 7.8 },
    { name: 'Noodle Bar', color: 0xd8c2ff, pos: [4, 2.2, -31.4], w: 10.4 }
  ];
  for (const shop of storefronts) {
    const facade = new THREE.Mesh(
      new THREE.BoxGeometry(shop.w, 3.8, 0.6),
      new THREE.MeshStandardMaterial({ color: shop.color, roughness: 0.35 })
    );
    facade.position.set(shop.pos[0], shop.pos[1], shop.pos[2]);
    scene.add(facade);

    const sign = new THREE.Mesh(
      new THREE.BoxGeometry(shop.w * 0.72, 0.8, 0.15),
      new THREE.MeshStandardMaterial({ color: 0x183a4f, roughness: 0.45 })
    );
    sign.position.set(shop.pos[0], 4.4, shop.pos[2] + Math.sign(shop.pos[2]) * -0.26);
    scene.add(sign);
  }

  const treeCrownMat = new THREE.MeshStandardMaterial({ color: 0x3f8d5b, roughness: 0.68 });
  const treeTrunkMat = new THREE.MeshStandardMaterial({ color: 0x6d5138, roughness: 0.92 });
  for (let i = -3; i <= 3; i += 1) {
    if (i === 0) continue;
    const x = i * 6.5;
    for (const z of [27.5, -27.5]) {
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.25, 2.2, 12), treeTrunkMat);
      trunk.position.set(x, 1.1, z);
      scene.add(trunk);

      const crown = new THREE.Mesh(new THREE.SphereGeometry(1.2, 14, 12), treeCrownMat);
      crown.position.set(x, 2.7, z);
      scene.add(crown);
    }
  }

  const laneMark = new THREE.MeshStandardMaterial({ color: 0xe6eaed, roughness: 0.56 });
  for (let z = -25; z <= 25; z += 4.2) {
    const dash = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.06, 2.3), laneMark);
    dash.position.set(0, 0.05, z);
    scene.add(dash);
  }
  for (let x = -19; x <= 19; x += 4.2) {
    const up = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.06, 0.4), laneMark);
    up.position.set(x, 0.05, 16);
    scene.add(up);
    const down = up.clone();
    down.position.set(x, 0.05, -16);
    scene.add(down);
  }
}

function createHumanoid(color) {
  const person = new THREE.Group();

  const torso = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.22, 0.58, 3, 8),
    new THREE.MeshStandardMaterial({ color, roughness: 0.62 })
  );
  torso.position.y = 1.05;
  person.add(torso);

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.17, 12, 12),
    new THREE.MeshStandardMaterial({ color: 0xf1d6bf, roughness: 0.55 })
  );
  head.position.y = 1.62;
  person.add(head);

  const limbMat = new THREE.MeshStandardMaterial({ color: 0x173042, roughness: 0.74 });
  const leftArm = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.38, 3, 8), limbMat);
  const rightArm = leftArm.clone();
  leftArm.position.set(-0.24, 1.17, 0);
  rightArm.position.set(0.24, 1.17, 0);
  person.add(leftArm);
  person.add(rightArm);

  const leftLeg = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.44, 3, 8), limbMat);
  const rightLeg = leftLeg.clone();
  leftLeg.position.set(-0.1, 0.55, 0);
  rightLeg.position.set(0.1, 0.55, 0);
  person.add(leftLeg);
  person.add(rightLeg);

  return { person, leftArm, rightArm, leftLeg, rightLeg };
}

function createAgents(scene) {
  const palette = [0x79bbcf, 0xffbe7f, 0x97e39f, 0xe7a6c7, 0xcdb8ff, 0xf7e487];
  const agents = [];

  for (let i = 0; i < 86; i += 1) {
    const human = createHumanoid(palette[i % palette.length]);
    const from = Math.floor(rand(0, WALK_NODES.length));
    const candidates = WALK_LINKS[from];
    const to = candidates[Math.floor(rand(0, candidates.length))];
    human.person.position.copy(WALK_NODES[from]).add(new THREE.Vector3(rand(-0.28, 0.28), 0, rand(-0.28, 0.28)));
    human.person.userData = {
      from,
      to,
      progress: rand(0, 0.85),
      speed: rand(0.22, 0.58),
      pause: 0,
      stridePhase: rand(0, Math.PI * 2),
      jitter: rand(-0.22, 0.22)
    };
    human.person.userData.limbs = {
      leftArm: human.leftArm,
      rightArm: human.rightArm,
      leftLeg: human.leftLeg,
      rightLeg: human.rightLeg
    };
    scene.add(human.person);
    agents.push(human.person);
  }

  return { agents };
}

export default function Simulation3D() {
  const mountRef = useRef(null);
  const activeCameraRef = useRef(0);
  const [activeCameraIndex, setActiveCameraIndex] = useState(0);

  useEffect(() => {
    activeCameraRef.current = activeCameraIndex;
  }, [activeCameraIndex]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'ArrowLeft') {
        setActiveCameraIndex((prev) => (prev - 1 + CAMERA_PRESETS.length) % CAMERA_PRESETS.length);
      } else if (event.key === 'ArrowRight') {
        setActiveCameraIndex((prev) => (prev + 1) % CAMERA_PRESETS.length);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    const mountEl = mountRef.current;
    if (!mountEl) return undefined;

    const scene = new THREE.Scene();
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mountEl.appendChild(renderer.domElement);

    const cameras = CAMERA_PRESETS.map((preset) => {
      const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 600);
      camera.position.set(...preset.position);
      camera.lookAt(...preset.lookAt);
      return camera;
    });

    createIIntersection(scene);
    const crowdModel = createAgents(scene);
    const tmpDir = new THREE.Vector3();
    const tmpLook = new THREE.Vector3();
    const clock = new THREE.Clock();

    const setSize = () => {
      const width = mountEl.clientWidth;
      const height = mountEl.clientHeight;
      renderer.setSize(width, height, false);
      for (const camera of cameras) {
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      }
    };
    setSize();
    window.addEventListener('resize', setSize);

    let rafId = 0;
    const animate = () => {
      const dt = Math.min(clock.getDelta(), 0.05);
      const t = clock.elapsedTime;

      for (const agent of crowdModel.agents) {
        const state = agent.userData;
        const from = WALK_NODES[state.from];
        const to = WALK_NODES[state.to];

        if (state.pause > 0) {
          state.pause -= dt;
        } else {
          state.progress += dt * state.speed;
        }

        if (state.progress >= 1) {
          state.from = state.to;
          const options = WALK_LINKS[state.from];
          state.to = options[Math.floor(Math.random() * options.length)];
          state.progress = 0;
          state.pause = Math.random() < 0.12 ? rand(0.2, 1.1) : 0;
          state.jitter = rand(-0.22, 0.22);
        }

        agent.position.lerpVectors(from, to, state.progress);
        agent.position.x += state.jitter;
        const bob = Math.sin(t * 6 + state.stridePhase) * 0.03;
        agent.position.y = 0.02 + bob;

        tmpLook.lerpVectors(from, to, Math.min(state.progress + 0.1, 1));
        agent.lookAt(tmpLook.x, agent.position.y + 1.0, tmpLook.z);

        tmpDir.subVectors(to, from).normalize();
        const gait = Math.sin(t * 7.5 + state.stridePhase);
        const armSwing = gait * 0.65;
        const legSwing = -gait * 0.72;
        state.limbs.leftArm.rotation.x = armSwing;
        state.limbs.rightArm.rotation.x = -armSwing;
        state.limbs.leftLeg.rotation.x = legSwing;
        state.limbs.rightLeg.rotation.x = -legSwing;
        const heading = Math.atan2(tmpDir.x, tmpDir.z);
        agent.rotation.y = heading;
      }

      const active = cameras[activeCameraRef.current] || cameras[0];
      renderer.render(scene, active);
      rafId = requestAnimationFrame(animate);
    };
    animate();

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', setSize);
      renderer.dispose();
      if (mountEl.contains(renderer.domElement)) {
        mountEl.removeChild(renderer.domElement);
      }
    };
  }, []);

  const prevCamera = () =>
    setActiveCameraIndex((prev) => (prev - 1 + CAMERA_PRESETS.length) % CAMERA_PRESETS.length);

  const nextCamera = () =>
    setActiveCameraIndex((prev) => (prev + 1) % CAMERA_PRESETS.length);

  return (
    <div className="sim-page">
      <header className="sim-header">
        <h1>3D I-Junction Surveillance Demo</h1>
        <p>Random pedestrian movement, colored street assets, and wall-mounted camera switching.</p>
      </header>
      <div className="sim-stage-wrap">
        <div ref={mountRef} className="sim-stage" />
        <button className="cam-nav left" onClick={prevCamera} aria-label="Previous camera">
          &lt;
        </button>
        <button className="cam-nav right" onClick={nextCamera} aria-label="Next camera">
          &gt;
        </button>
        <div className="sim-label center">
          {CAMERA_PRESETS[activeCameraIndex].label} ({activeCameraIndex + 1}/{CAMERA_PRESETS.length})
        </div>
      </div>
    </div>
  );
}
