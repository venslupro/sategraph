/**
 * Three.js scene for the globe view. Rendering is intentionally imperative: the
 * React layer owns state, this module owns GPU resources and the frame loop.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { geoToUnit, buildLandDots } from '../data/land';

export interface SatelliteMeta {
  id: string;
  layerId: string;
  color: string;
}

export interface OrbitRing {
  id: string;
  layerId: string;
  inclinationDeg: number;
  raanDeg: number;
  altitudeKm: number;
}

export interface PositionSample {
  id: string;
  lat: number;
  lon: number;
  altKm: number;
  speedKmS: number;
}

export type ConfidenceLevel = 'DECLARED' | 'DERIVED' | 'MODELED';

export interface SceneLink {
  id: string;
  fromId: string;
  toId: string;
  confidence: ConfidenceLevel;
  layerId: string;
}

export interface SceneCallbacks {
  onSelect: (id: string | null) => void;
  onHover: (id: string | null, x: number, y: number) => void;
}

const DEG = Math.PI / 180;
const LINK_COLORS: Record<ConfidenceLevel, number> = {
  DECLARED: 0xffc857,
  DERIVED: 0xdce9f7,
  MODELED: 0x3fd0ff,
};

/** Applies altitude compression so GEO stays visible near the globe. */
export function displayRadius(altKm: number): number {
  const clamped = Math.min(Math.max(altKm, 0), 42_000);
  return 1 + clamped / 39_762;
}

function toDisplayVector(latDeg: number, lonDeg: number, radius: number): THREE.Vector3 {
  const [x, y, z] = geoToUnit(lonDeg, latDeg, radius);
  return new THREE.Vector3(x, y, z);
}

function orbitPoint(
  inclinationDeg: number,
  raanDeg: number,
  altitudeKm: number,
  angle: number,
  target: THREE.Vector3,
): void {
  const inclination = inclinationDeg * DEG;
  const raan = raanDeg * DEG;
  const radius = displayRadius(altitudeKm);
  const x = Math.cos(raan) * Math.cos(angle) - Math.sin(raan) * Math.sin(angle) * Math.cos(inclination);
  const y = Math.sin(raan) * Math.cos(angle) + Math.cos(raan) * Math.sin(angle) * Math.cos(inclination);
  const z = Math.sin(angle) * Math.sin(inclination);
  target.set(x * radius, z * radius, -y * radius);
}

export class GlobeScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly satellites: SatelliteMeta[] = [];
  private readonly indexById = new Map<string, number>();
  private readonly activePositions = new Map<string, THREE.Vector3>();
  private positionsPrev: Float32Array = new Float32Array(0);
  private positionsNext: Float32Array = new Float32Array(0);
  private positionsCurrent: Float32Array = new Float32Array(0);
  private positionStamp = 0;
  private readonly colors: Float32Array;
  private readonly pointGeometry: THREE.BufferGeometry;
  private readonly points: THREE.Points;
  private readonly selection: THREE.Mesh;
  private readonly earthMaterial: THREE.ShaderMaterial;
  private readonly linkGroups: Record<ConfidenceLevel, THREE.LineSegments>;
  private readonly linkPositions: Record<ConfidenceLevel, Float32Array>;
  private links: SceneLink[] = [];
  private highlightLinks: Set<string> | null = null;
  private readonly visibleLayers = new Set<string>();
  private readonly visibleConfidence = new Set<ConfidenceLevel>([
    'DECLARED',
    'DERIVED',
    'MODELED',
  ]);
  private readonly ringsGroup = new THREE.Group();
  private ringData: OrbitRing[] = [];
  private groundTrack: THREE.Line | null = null;
  private selectedId: string | null = null;
  private hoverId: string | null = null;
  private readonly sunDirection = new THREE.Vector3(1, 0, 0);
  private readonly callbacks: SceneCallbacks;
  private readonly resizeObserver: ResizeObserver;
  private readonly pointerDown = { x: 0, y: 0 };
  private disposed = false;
  private focusTarget: { position: THREE.Vector3; startedAt: number } | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    satellites: SatelliteMeta[],
    callbacks: SceneCallbacks,
  ) {
    this.callbacks = callbacks;
    this.satellites = [...satellites];
    this.satellites.forEach((satellite, index) => this.indexById.set(satellite.id, index));
    this.colors = new Float32Array(this.satellites.length * 3);
    this.satellites.forEach((satellite, index) => {
      const color = new THREE.Color(satellite.color);
      this.colors[index * 3] = color.r;
      this.colors[index * 3 + 1] = color.g;
      this.colors[index * 3 + 2] = color.b;
    });

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x03070f, 0);

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.01, 120);
    this.camera.position.set(0, 1.35, 3.4);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.enablePan = false;
    this.controls.minDistance = 1.28;
    this.controls.maxDistance = 7;
    this.controls.rotateSpeed = 0.55;
    this.controls.zoomSpeed = 0.7;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.28;

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    this.earthMaterial = this.buildEarth();
    this.buildAtmosphere();
    this.buildStars();
    this.buildGrid();
    this.buildLand();

    this.pointGeometry = new THREE.BufferGeometry();
    this.pointGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(this.satellites.length * 3), 3),
    );
    this.pointGeometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    const pointMaterial = new THREE.PointsMaterial({
      size: 2.6,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });
    this.points = new THREE.Points(this.pointGeometry, pointMaterial);
    this.scene.add(this.points);

    const selectionGeometry = new THREE.RingGeometry(0.012, 0.019, 40);
    this.selection = new THREE.Mesh(
      selectionGeometry,
      new THREE.MeshBasicMaterial({
        color: 0x3fd0ff,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    this.selection.visible = false;
    this.scene.add(this.selection);

    this.scene.add(this.ringsGroup);
    this.linkGroups = {
      DECLARED: this.buildLinkLayer(0, 'solid'),
      DERIVED: this.buildLinkLayer(1, 'dashed'),
      MODELED: this.buildLinkLayer(2, 'dashdot'),
    };
    this.linkPositions = {
      DECLARED: new Float32Array(0),
      DERIVED: new Float32Array(0),
      MODELED: new Float32Array(0),
    };

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement ?? canvas);
    this.resize();
    this.bindEvents();
    this.animate();
  }

  private buildEarth(): THREE.ShaderMaterial {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        sunDirection: { value: this.sunDirection },
      },
      vertexShader: `
        varying vec3 vNormal;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 sunDirection;
        varying vec3 vNormal;
        void main() {
          float light = smoothstep(-0.18, 0.4, dot(normalize(vNormal), sunDirection));
          vec3 night = vec3(0.008, 0.028, 0.058);
          vec3 day = vec3(0.022, 0.10, 0.17);
          vec3 color = mix(night, day, light);
          gl_FragColor = vec4(color, 1.0);
        }
      `,
    });
    const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 96), material);
    this.scene.add(earth);
    return material;
  }

  private buildAtmosphere(): void {
    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(1.065, 64, 64),
      new THREE.ShaderMaterial({
        vertexShader: `
          varying vec3 vNormal;
          void main() {
            vNormal = normalize(normalMatrix * normal);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          varying vec3 vNormal;
          void main() {
            float intensity = pow(0.66 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 2.4);
            gl_FragColor = vec4(0.19, 0.62, 0.95, 1.0) * intensity;
          }
        `,
        blending: THREE.AdditiveBlending,
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
      }),
    );
    this.scene.add(atmosphere);
  }

  private buildStars(): void {
    const count = 1400;
    const positions = new Float32Array(count * 3);
    for (let index = 0; index < count; index += 1) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const radius = 24 + Math.random() * 16;
      positions[index * 3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[index * 3 + 1] = radius * Math.cos(phi);
      positions[index * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      color: 0xbcd6ee,
      size: 0.9,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.55,
    });
    this.scene.add(new THREE.Points(geometry, material));
  }

  private buildGrid(): void {
    const positions: number[] = [];
    for (let lat = -60; lat <= 60; lat += 30) {
      for (let lon = -180; lon < 180; lon += 4) {
        const [x1, y1, z1] = geoToUnit(lon, lat, 1.0015);
        const [x2, y2, z2] = geoToUnit(lon + 4, lat, 1.0015);
        positions.push(x1, y1, z1, x2, y2, z2);
      }
    }
    for (let lon = -180; lon < 180; lon += 30) {
      for (let lat = -88; lat < 88; lat += 4) {
        const [x1, y1, z1] = geoToUnit(lon, lat, 1.0015);
        const [x2, y2, z2] = geoToUnit(lon, lat + 4, 1.0015);
        positions.push(x1, y1, z1, x2, y2, z2);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    this.scene.add(
      new THREE.LineSegments(
        geometry,
        new THREE.LineBasicMaterial({
          color: 0x3fd0ff,
          transparent: true,
          opacity: 0.06,
        }),
      ),
    );
  }

  private buildLand(): void {
    const dots = buildLandDots(1.7);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(dots, 3));
    this.scene.add(
      new THREE.Points(
        geometry,
        new THREE.PointsMaterial({
          color: 0x2e7fa8,
          size: 1.35,
          sizeAttenuation: false,
          transparent: true,
          opacity: 0.92,
        }),
      ),
    );
  }

  private buildLinkLayer(
    order: number,
    style: 'solid' | 'dashed' | 'dashdot',
  ): THREE.LineSegments {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    const color = LINK_COLORS[(['DECLARED', 'DERIVED', 'MODELED'] as const)[order]];
    const handle =
      style === 'solid'
        ? new THREE.LineBasicMaterial({
            color,
            transparent: true,
            opacity: 0.55,
            depthWrite: false,
          })
        : new THREE.LineDashedMaterial({
            color,
            transparent: true,
            opacity: 0.42,
            depthWrite: false,
            dashSize: style === 'dashdot' ? 0.012 : 0.02,
            gapSize: style === 'dashdot' ? 0.008 : 0.012,
          });
    const lines = new THREE.LineSegments(geometry, handle);
    lines.frustumCulled = false;
    this.scene.add(lines);
    return lines;
  }

  private resize(): void {
    const parent = this.canvas.parentElement;
    const width = parent?.clientWidth ?? 1;
    const height = parent?.clientHeight ?? 1;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
  }

  private bindEvents(): void {
    this.canvas.addEventListener('pointerdown', this.handlePointerDown);
    this.canvas.addEventListener('pointerup', this.handlePointerUp);
    this.canvas.addEventListener('pointermove', this.handlePointerMove);
    this.canvas.addEventListener('pointerleave', this.handlePointerLeave);
  }

  private handlePointerDown = (event: PointerEvent): void => {
    this.pointerDown.x = event.clientX;
    this.pointerDown.y = event.clientY;
  };

  private handlePointerUp = (event: PointerEvent): void => {
    const moved = Math.hypot(event.clientX - this.pointerDown.x, event.clientY - this.pointerDown.y);
    if (moved > 5) {
      return;
    }
    this.pick(event);
    this.callbacks.onSelect(this.hoverId);
  };

  private handlePointerMove = (event: PointerEvent): void => {
    this.pick(event);
    const rect = this.canvas.getBoundingClientRect();
    this.callbacks.onHover(
      this.hoverId,
      event.clientX - rect.left,
      event.clientY - rect.top,
    );
  };

  private handlePointerLeave = (): void => {
    this.hoverId = null;
    this.callbacks.onHover(null, 0, 0);
  };

  private pick(event: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    this.raycaster.params.Points = {
      threshold: 0.008 * Math.max(this.camera.position.length() / 3, 1),
    };
    const hits = this.raycaster.intersectObject(this.points, false);
    const index = hits[0]?.index;
    this.hoverId =
      typeof index === 'number' ? (this.satellites[index]?.id ?? null) : null;
  }

  setLayers(layers: Iterable<string>): void {
    this.visibleLayers.clear();
    for (const layer of layers) {
      this.visibleLayers.add(layer);
    }
    this.rebuildRings();
  }

  setConfidence(levels: Iterable<ConfidenceLevel>): void {
    this.visibleConfidence.clear();
    for (const level of levels) {
      this.visibleConfidence.add(level);
    }
  }

  setLinks(links: SceneLink[]): void {
    this.links = links;
    const counts: Record<ConfidenceLevel, number> = { DECLARED: 0, DERIVED: 0, MODELED: 0 };
    for (const link of links) {
      counts[link.confidence] += 1;
    }
    for (const level of ['DECLARED', 'DERIVED', 'MODELED'] as const) {
      this.linkPositions[level] = new Float32Array(counts[level] * 6);
      const attribute = new THREE.BufferAttribute(this.linkPositions[level], 3);
      attribute.setUsage(THREE.DynamicDrawUsage);
      this.linkGroups[level].geometry.setAttribute('position', attribute);
      this.linkGroups[level].visible = counts[level] > 0;
    }
    this.updateLinks();
  }

  /** Restricts link rendering to the given ids; null restores all links. */
  setHighlightLinks(ids: Iterable<string> | null): void {
    this.highlightLinks = ids ? new Set(ids) : null;
    this.updateLinks();
  }

  setOrbitRings(rings: OrbitRing[]): void {
    this.ringData = rings;
    this.rebuildRings();
  }

  private rebuildRings(): void {
    this.ringsGroup.clear();
    const positions: number[] = [];
    const colors: number[] = [];
    const point = new THREE.Vector3();
    for (const ring of this.ringData) {
      if (!this.visibleLayers.has(ring.layerId)) {
        continue;
      }
      const meta = this.satellites.find((satellite) => satellite.id === ring.id);
      const color = new THREE.Color(meta?.color ?? '#2e7fa8');
      for (let step = 0; step < 96; step += 1) {
        orbitPoint(
          ring.inclinationDeg,
          ring.raanDeg,
          ring.altitudeKm,
          (step / 96) * Math.PI * 2,
          point,
        );
        const next = new THREE.Vector3();
        orbitPoint(
          ring.inclinationDeg,
          ring.raanDeg,
          ring.altitudeKm,
          ((step + 1) / 96) * Math.PI * 2,
          next,
        );
        positions.push(point.x, point.y, point.z, next.x, next.y, next.z);
        colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
      }
    }
    if (positions.length === 0) {
      return;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this.ringsGroup.add(
      new THREE.LineSegments(
        geometry,
        new THREE.LineBasicMaterial({
          vertexColors: true,
          transparent: true,
          opacity: 0.24,
          depthWrite: false,
        }),
      ),
    );
  }

  setPositions(samples: PositionSample[]): void {
    if (this.positionsCurrent.length !== this.satellites.length * 3) {
      this.positionsCurrent = new Float32Array(this.satellites.length * 3);
      this.positionsPrev = new Float32Array(this.satellites.length * 3);
      this.positionsNext = new Float32Array(this.satellites.length * 3);
      this.pointGeometry.setAttribute(
        'position',
        new THREE.BufferAttribute(this.positionsCurrent, 3).setUsage(THREE.DynamicDrawUsage),
      );
    }
    this.positionsPrev.set(this.positionsCurrent);
    this.positionsNext.fill(Number.NaN);
    this.activePositions.clear();
    for (const sample of samples) {
      const index = this.indexById.get(sample.id);
      if (index === undefined) {
        continue;
      }
      const vector = toDisplayVector(sample.lat, sample.lon, displayRadius(sample.altKm));
      this.activePositions.set(sample.id, vector);
      this.positionsNext[index * 3] = vector.x;
      this.positionsNext[index * 3 + 1] = vector.y;
      this.positionsNext[index * 3 + 2] = vector.z;
    }
    this.positionStamp = performance.now();
    this.updateLinks();
    this.updateSelection();
    this.updateGroundTrack();
  }

  setSelected(id: string | null): void {
    this.selectedId = id;
    this.selection.visible = id !== null;
    this.updateSelection();
  }

  setGroundTrack(points: { lat: number; lon: number }[]): void {
    if (this.groundTrack) {
      this.scene.remove(this.groundTrack);
      this.groundTrack.geometry.dispose();
      (this.groundTrack.material as THREE.Material).dispose();
      this.groundTrack = null;
    }
    if (points.length < 2) {
      return;
    }
    const positions = new Float32Array(points.length * 3);
    points.forEach((point, index) => {
      const [x, y, z] = geoToUnit(point.lon, point.lat, 1.006);
      positions[index * 3] = x;
      positions[index * 3 + 1] = y;
      positions[index * 3 + 2] = z;
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.groundTrack = new THREE.Line(
      geometry,
      new THREE.LineBasicMaterial({
        color: 0x3fd0ff,
        transparent: true,
        opacity: 0.55,
      }),
    );
    this.scene.add(this.groundTrack);
  }

  setSun(isoTime: string): void {
    const date = new Date(isoTime);
    if (Number.isNaN(date.getTime())) {
      return;
    }
    const start = Date.UTC(date.getUTCFullYear(), 0, 1);
    const dayOfYear = (date.getTime() - start) / 86_400_000;
    const declination = -23.44 * Math.cos((2 * Math.PI * (dayOfYear + 10)) / 365.24);
    const hours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
    const subsolarLongitude = 180 - hours * 15;
    const [x, y, z] = geoToUnit(subsolarLongitude, declination, 1);
    this.sunDirection.set(x, y, z).normalize();
    this.earthMaterial.uniforms.sunDirection.value = this.sunDirection;
  }

  focus(id: string): void {
    const target = this.activePositions.get(id);
    if (!target) {
      return;
    }
    this.focusTarget = {
      position: target.clone().normalize().multiplyScalar(2.7),
      startedAt: performance.now(),
    };
  }

  setAutoRotate(enabled: boolean): void {
    this.controls.autoRotate = enabled;
  }

  private updateSelection(): void {
    if (!this.selectedId) {
      this.selection.visible = false;
      return;
    }
    const position = this.activePositions.get(this.selectedId);
    if (!position) {
      this.selection.visible = false;
      return;
    }
    this.selection.visible = true;
    this.selection.position.copy(position);
  }

  private updateGroundTrack(): void {
    if (!this.groundTrack || !this.selectedId) {
      return;
    }
    const points = this.groundTrack.geometry.getAttribute('position');
    if (!points) {
      return;
    }
    // The track is anchored to inertial geometry; fade it when time moves far
    // from the selection moment by hiding stale segments.
    this.groundTrack.visible = this.activePositions.has(this.selectedId);
  }

  private updateLinks(): void {
    const cursors: Record<ConfidenceLevel, number> = { DECLARED: 0, DERIVED: 0, MODELED: 0 };
    for (const link of this.links) {
      if (this.highlightLinks && !this.highlightLinks.has(link.id)) {
        continue;
      }
      if (!this.visibleConfidence.has(link.confidence)) {
        continue;
      }
      if (!this.visibleLayers.has(link.layerId)) {
        continue;
      }
      const from = this.activePositions.get(link.fromId);
      const to = this.activePositions.get(link.toId);
      if (!from || !to) {
        continue;
      }
      const cursor = cursors[link.confidence];
      const buffer = this.linkPositions[link.confidence];
      if (cursor * 6 + 6 > buffer.length) {
        continue;
      }
      buffer[cursor * 6] = from.x;
      buffer[cursor * 6 + 1] = from.y;
      buffer[cursor * 6 + 2] = from.z;
      buffer[cursor * 6 + 3] = to.x;
      buffer[cursor * 6 + 4] = to.y;
      buffer[cursor * 6 + 5] = to.z;
      cursors[link.confidence] += 1;
    }
    for (const level of ['DECLARED', 'DERIVED', 'MODELED'] as const) {
      const attribute = this.linkGroups[level].geometry.getAttribute('position');
      if (attribute instanceof THREE.BufferAttribute) {
        attribute.needsUpdate = true;
        this.linkGroups[level].geometry.setDrawRange(0, cursors[level] * 2);
      }
      const material = this.linkGroups[level].material;
      if (material instanceof THREE.LineDashedMaterial) {
        material.opacity = this.highlightLinks ? 0.85 : 0.42;
      } else if (material instanceof THREE.LineBasicMaterial) {
        material.opacity = this.highlightLinks ? 0.9 : 0.55;
      }
      if (this.linkGroups[level].material instanceof THREE.LineDashedMaterial) {
        this.linkGroups[level].computeLineDistances();
      }
    }
  }

  private animate = (): void => {
    if (this.disposed) {
      return;
    }
    requestAnimationFrame(this.animate);
    const elapsed = performance.now();
    const blend = Math.min((elapsed - this.positionStamp) / 260, 1);
    if (this.positionsCurrent.length > 0) {
      for (let index = 0; index < this.positionsCurrent.length; index += 3) {
        const nextX = this.positionsNext[index];
        if (Number.isNaN(nextX)) {
          this.positionsCurrent[index] = 0;
          this.positionsCurrent[index + 1] = 0;
          this.positionsCurrent[index + 2] = 0;
          continue;
        }
        this.positionsCurrent[index] =
          this.positionsPrev[index] + (nextX - this.positionsPrev[index]) * blend;
        this.positionsCurrent[index + 1] =
          this.positionsPrev[index + 1] +
          (this.positionsNext[index + 1] - this.positionsPrev[index + 1]) * blend;
        this.positionsCurrent[index + 2] =
          this.positionsPrev[index + 2] +
          (this.positionsNext[index + 2] - this.positionsPrev[index + 2]) * blend;
      }
      const attribute = this.pointGeometry.getAttribute('position');
      if (attribute instanceof THREE.BufferAttribute) {
        attribute.needsUpdate = true;
      }
    }

    if (this.selectedId) {
      const sample = this.activePositions.get(this.selectedId);
      if (sample) {
        this.selection.position.copy(sample);
      }
    }
    const pulse = 1 + Math.sin(elapsed / 380) * 0.22;
    this.selection.scale.setScalar(pulse);
    this.selection.quaternion.copy(this.camera.quaternion);

    if (this.focusTarget) {
      const progress = Math.min((elapsed - this.focusTarget.startedAt) / 1100, 1);
      const eased = 1 - (1 - progress) ** 3;
      this.camera.position.lerp(this.focusTarget.position, eased * 0.18);
      if (progress >= 1) {
        this.focusTarget = null;
      }
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    this.disposed = true;
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointerup', this.handlePointerUp);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerleave', this.handlePointerLeave);
    this.controls.dispose();
    this.renderer.dispose();
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points) {
        object.geometry.dispose();
        const material = object.material;
        if (Array.isArray(material)) {
          material.forEach((item) => item.dispose());
        } else {
          material.dispose();
        }
      }
    });
  }
}
