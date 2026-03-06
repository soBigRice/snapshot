import { startTransition, useEffect, useRef, useState } from 'react'
import * as THREE from 'three'

type GamePhase = 'ready' | 'playing' | 'paused' | 'ended'
type TargetKind = 'normal' | 'big' | 'flash' | 'small' | 'trap'

interface PopupState {
  id: number
  text: string
  x: number
  y: number
  positive: boolean
  warning: boolean
}

interface HudState {
  activeTargets: number
  bestScore: number
  combo: number
  multiplier: number
  phase: GamePhase
  score: number
  status: string
  timeLeft: number
}

interface TargetSpec {
  baseOpacity: number
  color: string
  description: string
  fill: string
  glow: string
  label: string
  life: [number, number]
  pulse: number
  radius: number
  score: number
  trap?: boolean
  weight: number
}

interface MaterialHandle {
  baseOpacity: number
  material: THREE.MeshBasicMaterial
}

interface TargetEntity {
  accent?: THREE.Object3D
  age: number
  group: THREE.Group
  id: number
  life: number
  materials: MaterialHandle[]
  position: THREE.Vector2
  radius: number
  seed: number
  spec: TargetSpec
  spin: number
}

interface BulletEntity {
  age: number
  group: THREE.Group
  id: number
  position: THREE.Vector2
  radius: number
  velocity: THREE.Vector2
}

interface ParticleEntity {
  age: number
  drag: number
  life: number
  mesh: THREE.Mesh
  spin: number
  velocity: THREE.Vector2
}

interface EngineHandle {
  end: (status?: string) => void
  pause: (status?: string) => void
  resume: () => void
  start: () => void
}

const GAME_DURATION = 60
const MAX_TARGETS = 5
const SHOT_COOLDOWN = 0.12
const BULLET_SPEED = 960
const BEST_SCORE_KEY = 'snap-shot-best-score'

const TARGET_SPECS: Record<TargetKind, TargetSpec> = {
  normal: {
    baseOpacity: 0.92,
    color: '#8bf3ff',
    description: '标准训练靶',
    fill: '#0f2d4e',
    glow: '#69efff',
    label: '普通靶',
    life: [1.5, 2.5],
    pulse: 5.4,
    radius: 28,
    score: 100,
    weight: 5,
  },
  big: {
    baseOpacity: 0.84,
    color: '#7cff9b',
    description: '尺寸大，节奏稳定',
    fill: '#0e3322',
    glow: '#6bffbb',
    label: '大型靶',
    life: [2.1, 3.0],
    pulse: 3.9,
    radius: 42,
    score: 50,
    weight: 3.1,
  },
  flash: {
    baseOpacity: 0.98,
    color: '#ffd772',
    description: '快闪高分，停留极短',
    fill: '#422505',
    glow: '#ffcf49',
    label: '快闪靶',
    life: [0.6, 1.2],
    pulse: 9.5,
    radius: 24,
    score: 250,
    weight: 2,
  },
  small: {
    baseOpacity: 0.96,
    color: '#f0a3ff',
    description: '高分小靶，命中窗口窄',
    fill: '#32173a',
    glow: '#f46dff',
    label: '小型靶',
    life: [1.0, 1.8],
    pulse: 7.6,
    radius: 17,
    score: 350,
    weight: 1.4,
  },
  trap: {
    baseOpacity: 0.92,
    color: '#ff6f6f',
    description: '误击会扣分并清空连击',
    fill: '#3a1118',
    glow: '#ff7f9d',
    label: '陷阱靶',
    life: [1.3, 2.2],
    pulse: 6.8,
    radius: 32,
    score: -200,
    trap: true,
    weight: 1.2,
  },
}

const TARGET_ORDER = Object.keys(TARGET_SPECS) as TargetKind[]

const initialHudState: HudState = {
  activeTargets: 0,
  bestScore: 0,
  combo: 0,
  multiplier: 1,
  phase: 'ready',
  score: 0,
  status: '准备开始 60 秒训练',
  timeLeft: GAME_DURATION,
}

function randomBetween(min: number, max: number) {
  return THREE.MathUtils.randFloat(min, max)
}

function getMultiplier(combo: number) {
  if (combo >= 10) {
    return 2
  }

  if (combo >= 5) {
    return 1.5
  }

  return 1
}

function disposeObject3D(object: THREE.Object3D) {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose()

      if (Array.isArray(child.material)) {
        child.material.forEach((material) => material.dispose())
      } else {
        child.material.dispose()
      }
    }
  })
}

function clearGroup(group: THREE.Group) {
  while (group.children.length > 0) {
    const child = group.children[0]
    group.remove(child)
    disposeObject3D(child)
  }
}

function createMaterial(color: string, opacity: number) {
  return new THREE.MeshBasicMaterial({
    color,
    opacity,
    transparent: true,
  })
}

function pickTargetKind() {
  const totalWeight = TARGET_ORDER.reduce(
    (sum, key) => sum + TARGET_SPECS[key].weight,
    0,
  )

  let roll = Math.random() * totalWeight

  for (const key of TARGET_ORDER) {
    roll -= TARGET_SPECS[key].weight
    if (roll <= 0) {
      return key
    }
  }

  return 'normal'
}

function buildBackdrop(
  group: THREE.Group,
  width: number,
  height: number,
) {
  clearGroup(group)

  const backgroundPlate = new THREE.Mesh(
    new THREE.PlaneGeometry(width * 0.98, height * 0.95),
    createMaterial('#091724', 0.26),
  )
  backgroundPlate.position.z = -1.4
  group.add(backgroundPlate)

  const frameThickness = 6
  const frameMaterial = createMaterial('#1cd6f1', 0.2)
  const top = new THREE.Mesh(
    new THREE.PlaneGeometry(width * 0.94, frameThickness),
    frameMaterial.clone(),
  )
  top.position.set(0, height * 0.46, -1.2)
  group.add(top)

  const bottom = new THREE.Mesh(
    new THREE.PlaneGeometry(width * 0.94, frameThickness),
    frameMaterial.clone(),
  )
  bottom.position.set(0, -height * 0.46, -1.2)
  group.add(bottom)

  const sideHeight = height * 0.92
  const left = new THREE.Mesh(
    new THREE.PlaneGeometry(frameThickness, sideHeight),
    frameMaterial.clone(),
  )
  left.position.set(-width * 0.47, 0, -1.2)
  group.add(left)

  const right = new THREE.Mesh(
    new THREE.PlaneGeometry(frameThickness, sideHeight),
    frameMaterial.clone(),
  )
  right.position.set(width * 0.47, 0, -1.2)
  group.add(right)

  for (let index = 0; index < 8; index += 1) {
    const ratio = index / 7
    const line = new THREE.Mesh(
      new THREE.PlaneGeometry(width * 0.88, 2),
      createMaterial('#1ad4ef', 0.08 + ratio * 0.05),
    )
    line.position.set(0, -height * 0.24 + ratio * height * 0.52, -1.1)
    group.add(line)
  }

  for (let index = 0; index < 4; index += 1) {
    const ratio = index / 3
    const line = new THREE.Mesh(
      new THREE.PlaneGeometry(2, height * 0.72),
      createMaterial('#1ad4ef', 0.08 + ratio * 0.03),
    )
    line.position.set(-width * 0.24 + ratio * width * 0.48, 0, -1.1)
    group.add(line)
  }

  const ringOriginY = -height * 0.23
  for (let index = 0; index < 5; index += 1) {
    const radius = 110 + index * 60
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(radius - 2.2, radius, 72),
      createMaterial('#2aeaff', 0.05 + index * 0.03),
    )
    ring.position.set(0, ringOriginY, -1)
    group.add(ring)
  }

  const scanLine = new THREE.Mesh(
    new THREE.PlaneGeometry(width * 0.86, 6),
    createMaterial('#57ecff', 0.14),
  )
  scanLine.name = 'scan-line'
  scanLine.position.z = -0.8
  group.add(scanLine)
}

function createTargetVisual(spec: TargetSpec) {
  const group = new THREE.Group()
  const materials: MaterialHandle[] = []

  const haloMaterial = createMaterial(spec.glow, 0.14)
  const halo = new THREE.Mesh(
    new THREE.CircleGeometry(spec.radius * 1.22, 48),
    haloMaterial,
  )
  materials.push({ baseOpacity: 0.14, material: haloMaterial })
  group.add(halo)

  const shellMaterial = createMaterial(spec.color, spec.baseOpacity)
  const shell = new THREE.Mesh(
    new THREE.RingGeometry(spec.radius * 0.78, spec.radius, 48),
    shellMaterial,
  )
  materials.push({ baseOpacity: spec.baseOpacity, material: shellMaterial })
  group.add(shell)

  const fillMaterial = createMaterial(spec.fill, 0.9)
  const fill = new THREE.Mesh(
    new THREE.CircleGeometry(spec.radius * 0.75, 48),
    fillMaterial,
  )
  materials.push({ baseOpacity: 0.9, material: fillMaterial })
  group.add(fill)

  const coreRingMaterial = createMaterial(spec.glow, 0.75)
  const coreRing = new THREE.Mesh(
    new THREE.RingGeometry(spec.radius * 0.18, spec.radius * 0.4, 40),
    coreRingMaterial,
  )
  materials.push({ baseOpacity: 0.75, material: coreRingMaterial })
  group.add(coreRing)

  let accent: THREE.Object3D | undefined

  if (spec.label === '快闪靶') {
    const diamondMaterial = createMaterial('#fff0a8', 0.88)
    const diamond = new THREE.Mesh(
      new THREE.PlaneGeometry(spec.radius * 0.7, spec.radius * 0.7),
      diamondMaterial,
    )
    diamond.rotation.z = Math.PI / 4
    materials.push({ baseOpacity: 0.88, material: diamondMaterial })
    accent = diamond
    group.add(diamond)
  }

  if (spec.label === '大型靶') {
    const outerMaterial = createMaterial(spec.glow, 0.52)
    const outer = new THREE.Mesh(
      new THREE.RingGeometry(spec.radius * 1.06, spec.radius * 1.18, 48),
      outerMaterial,
    )
    materials.push({ baseOpacity: 0.52, material: outerMaterial })
    group.add(outer)
  }

  if (spec.label === '小型靶') {
    const dotMaterial = createMaterial('#ffffff', 0.92)
    const dot = new THREE.Mesh(
      new THREE.CircleGeometry(spec.radius * 0.15, 20),
      dotMaterial,
    )
    materials.push({ baseOpacity: 0.92, material: dotMaterial })
    accent = dot
    group.add(dot)
  }

  if (spec.trap) {
    const slashMaterialA = createMaterial('#ff9ca9', 0.85)
    const slashA = new THREE.Mesh(
      new THREE.PlaneGeometry(spec.radius * 1.35, 5),
      slashMaterialA,
    )
    slashA.rotation.z = Math.PI / 4
    materials.push({ baseOpacity: 0.85, material: slashMaterialA })
    group.add(slashA)

    const slashMaterialB = createMaterial('#ff9ca9', 0.85)
    const slashB = new THREE.Mesh(
      new THREE.PlaneGeometry(spec.radius * 1.35, 5),
      slashMaterialB,
    )
    slashB.rotation.z = -Math.PI / 4
    materials.push({ baseOpacity: 0.85, material: slashMaterialB })
    accent = slashB
    group.add(slashB)
  }

  return { accent, group, materials }
}

export function SnapshotGame() {
  const mountRef = useRef<HTMLDivElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const engineRef = useRef<EngineHandle | null>(null)
  const popupTimeoutsRef = useRef<number[]>([])

  const [hud, setHud] = useState(initialHudState)
  const [popups, setPopups] = useState<PopupState[]>([])

  useEffect(() => {
    const container = mountRef.current
    if (!container) {
      return undefined
    }
    const host = container

    const renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
    })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(host.clientWidth, host.clientHeight, false)
    renderer.setClearColor('#020812', 1)
    host.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200)
    camera.position.z = 20

    const backdropLayer = new THREE.Group()
    const targetLayer = new THREE.Group()
    const bulletLayer = new THREE.Group()
    const effectLayer = new THREE.Group()
    const uiLayer = new THREE.Group()
    const turretGroup = new THREE.Group()

    scene.add(backdropLayer, targetLayer, bulletLayer, effectLayer, turretGroup, uiLayer)

    const barrelPivot = new THREE.Group()
    const turretBase = new THREE.Mesh(
      new THREE.CircleGeometry(36, 48),
      createMaterial('#0f1e2b', 1),
    )
    const turretRing = new THREE.Mesh(
      new THREE.RingGeometry(38, 50, 48),
      createMaterial('#4fe4ff', 0.72),
    )
    const barrelCore = new THREE.Mesh(
      new THREE.PlaneGeometry(18, 116),
      createMaterial('#d5f9ff', 0.9),
    )
    barrelCore.position.y = 56
    const barrelGlow = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 120),
      createMaterial('#2ae6ff', 0.2),
    )
    barrelGlow.position.y = 56
    const muzzleFlash = new THREE.Mesh(
      new THREE.CircleGeometry(16, 28),
      createMaterial('#fff1a8', 0),
    )
    muzzleFlash.position.y = 112
    barrelPivot.add(barrelGlow, barrelCore, muzzleFlash)
    turretGroup.add(turretBase, turretRing, barrelPivot)

    const crosshair = new THREE.Group()
    const crosshairHorizontal = new THREE.Mesh(
      new THREE.PlaneGeometry(48, 2),
      createMaterial('#7bf3ff', 0.82),
    )
    const crosshairVertical = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 48),
      createMaterial('#7bf3ff', 0.82),
    )
    const crosshairRing = new THREE.Mesh(
      new THREE.RingGeometry(10, 12, 24),
      createMaterial('#ffffff', 0.9),
    )
    crosshair.add(crosshairHorizontal, crosshairVertical, crosshairRing)
    uiLayer.add(crosshair)

    const size = { height: 1, width: 1 }
    const turretOrigin = new THREE.Vector3(0, 0, 0)
    const pointerWorld = new THREE.Vector3(0, 200, 0)

    const targets: TargetEntity[] = []
    const bullets: BulletEntity[] = []
    const particles: ParticleEntity[] = []

    let targetId = 0
    let bulletId = 0
    let popupId = 0
    let frameId = 0
    let lastFrameTime = performance.now()
    let lastHudSync = 0
    let disposed = false
    let scanLine: THREE.Mesh | null = null

    const game = {
      bestScore: 0,
      combo: 0,
      elapsed: 0,
      lastShotAt: -Infinity,
      muzzleAmount: 0,
      nextSpawnAt: 0,
      phase: 'ready' as GamePhase,
      recoilAmount: 0,
      score: 0,
      status: '准备开始 60 秒训练',
      timeLeft: GAME_DURATION,
      turretAngle: 0,
    }

    try {
      const storedScore = window.localStorage.getItem(BEST_SCORE_KEY)
      if (storedScore) {
        game.bestScore = Number.parseInt(storedScore, 10) || 0
      }
    } catch {
      game.bestScore = 0
    }

    function setPopup(text: string, position: THREE.Vector2, positive: boolean, warning = false) {
      const projected = new THREE.Vector3(position.x, position.y, 0).project(camera)
      const x = ((projected.x + 1) * 0.5) * size.width
      const y = ((1 - projected.y) * 0.5) * size.height
      const id = popupId
      popupId += 1

      startTransition(() => {
        setPopups((current) => [
          ...current,
          { id, positive, text, warning, x, y },
        ])
      })

      const timeoutId = window.setTimeout(() => {
        startTransition(() => {
          setPopups((current) => current.filter((popup) => popup.id !== id))
        })
      }, 900)
      popupTimeoutsRef.current.push(timeoutId)
    }

    function emitHud(force = false) {
      const now = performance.now()
      if (!force && now - lastHudSync < 80) {
        return
      }

      lastHudSync = now

      const nextHud: HudState = {
        activeTargets: targets.length,
        bestScore: game.bestScore,
        combo: game.combo,
        multiplier: getMultiplier(game.combo),
        phase: game.phase,
        score: Math.round(game.score),
        status: game.status,
        timeLeft: Math.max(0, game.timeLeft),
      }

      startTransition(() => {
        setHud(nextHud)
      })
    }

    function rebuildBackdrop() {
      buildBackdrop(backdropLayer, size.width, size.height)
      scanLine = backdropLayer.getObjectByName('scan-line') as THREE.Mesh | null
    }

    function syncTurretFromPointer() {
      const minAimY = turretOrigin.y + 56
      pointerWorld.y = Math.max(pointerWorld.y, minAimY)

      const dx = pointerWorld.x - turretOrigin.x
      const dy = pointerWorld.y - turretOrigin.y
      game.turretAngle = Math.atan2(dy, dx)
      barrelPivot.rotation.z = game.turretAngle - Math.PI / 2

      const recoilOffset = game.recoilAmount * 12
      barrelCore.position.y = 56 - recoilOffset
      barrelGlow.position.y = 56 - recoilOffset
      muzzleFlash.position.y = 112 - recoilOffset

      crosshair.position.copy(pointerWorld)
      const pulse = 1 + Math.sin(game.elapsed * 8) * 0.05
      crosshair.scale.setScalar(pulse)
    }

    function resize() {
      const width = Math.max(host.clientWidth, 320)
      const height = Math.max(host.clientHeight, 420)
      size.width = width
      size.height = height

      renderer.setSize(width, height, false)
      camera.left = -width / 2
      camera.right = width / 2
      camera.top = height / 2
      camera.bottom = -height / 2
      camera.updateProjectionMatrix()

      turretOrigin.set(0, -height * 0.38, 0)
      turretGroup.position.copy(turretOrigin)

      if (pointerWorld.y < turretOrigin.y + 120) {
        pointerWorld.set(0, turretOrigin.y + 220, 0)
      }

      rebuildBackdrop()
      syncTurretFromPointer()
      emitHud(true)
    }

    function removeBullet(index: number) {
      const bullet = bullets[index]
      bulletLayer.remove(bullet.group)
      disposeObject3D(bullet.group)
      bullets.splice(index, 1)
    }

    function removeTarget(index: number) {
      const target = targets[index]
      targetLayer.remove(target.group)
      disposeObject3D(target.group)
      targets.splice(index, 1)
    }

    function removeParticle(index: number) {
      const particle = particles[index]
      effectLayer.remove(particle.mesh)
      disposeObject3D(particle.mesh)
      particles.splice(index, 1)
    }

    function clearEntities() {
      bullets.length = 0
      targets.length = 0
      particles.length = 0
      clearGroup(bulletLayer)
      clearGroup(targetLayer)
      clearGroup(effectLayer)
    }

    function resetCombo(status: string) {
      game.combo = 0
      game.status = status
    }

    function spawnParticles(position: THREE.Vector2, color: string, burst: number) {
      for (let index = 0; index < burst; index += 1) {
        const angle = (Math.PI * 2 * index) / burst + randomBetween(-0.2, 0.2)
        const speed = randomBetween(80, 220)
        const particle = new THREE.Mesh(
          new THREE.CircleGeometry(randomBetween(2, 4.4), 12),
          createMaterial(color, randomBetween(0.55, 0.9)),
        )
        particle.position.set(position.x, position.y, 0.3)
        effectLayer.add(particle)
        particles.push({
          age: 0,
          drag: randomBetween(1.8, 2.8),
          life: randomBetween(0.25, 0.55),
          mesh: particle,
          spin: randomBetween(-7, 7),
          velocity: new THREE.Vector2(Math.cos(angle) * speed, Math.sin(angle) * speed),
        })
      }
    }

    function spawnTarget() {
      if (targets.length >= MAX_TARGETS) {
        return
      }

      const kind = pickTargetKind()
      const spec = TARGET_SPECS[kind]
      const xMin = -size.width * 0.42
      const xMax = size.width * 0.42
      const yMin = Math.max(-size.height * 0.02, turretOrigin.y + 180)
      const yMax = size.height * 0.42
      let attempts = 14
      let position = new THREE.Vector2(0, yMin)
      let placed = false

      while (attempts > 0 && !placed) {
        position = new THREE.Vector2(randomBetween(xMin, xMax), randomBetween(yMin, yMax))
        placed = targets.every(
          (target) =>
            target.position.distanceTo(position) >
            target.radius + spec.radius + 28,
        )
        attempts -= 1
      }

      if (!placed) {
        return
      }

      const visual = createTargetVisual(spec)
      visual.group.position.set(position.x, position.y, 0)
      targetLayer.add(visual.group)

      targets.push({
        accent: visual.accent,
        age: 0,
        group: visual.group,
        id: targetId,
        life: randomBetween(spec.life[0], spec.life[1]),
        materials: visual.materials,
        position,
        radius: spec.radius,
        seed: Math.random() * Math.PI * 2,
        spec,
        spin: randomBetween(-0.7, 0.7),
      })

      targetId += 1
      emitHud()
    }

    function fireBullet() {
      if (game.phase !== 'playing') {
        return
      }

      if (game.elapsed - game.lastShotAt < SHOT_COOLDOWN) {
        return
      }

      const direction = new THREE.Vector2(
        pointerWorld.x - turretOrigin.x,
        pointerWorld.y - turretOrigin.y,
      ).normalize()
      const spawnPosition = new THREE.Vector2(
        turretOrigin.x + direction.x * 116,
        turretOrigin.y + direction.y * 116,
      )

      const bulletGroup = new THREE.Group()
      const trail = new THREE.Mesh(
        new THREE.PlaneGeometry(5, 24),
        createMaterial('#35ecff', 0.58),
      )
      trail.position.y = -14
      const core = new THREE.Mesh(
        new THREE.CircleGeometry(5.5, 16),
        createMaterial('#fffce1', 0.96),
      )
      const flare = new THREE.Mesh(
        new THREE.CircleGeometry(10, 18),
        createMaterial('#83f9ff', 0.18),
      )
      bulletGroup.add(flare, trail, core)
      bulletGroup.position.set(spawnPosition.x, spawnPosition.y, 0.2)
      bulletGroup.rotation.z = Math.atan2(direction.y, direction.x) - Math.PI / 2
      bulletLayer.add(bulletGroup)

      bullets.push({
        age: 0,
        group: bulletGroup,
        id: bulletId,
        position: spawnPosition,
        radius: 10,
        velocity: direction.multiplyScalar(BULLET_SPEED),
      })

      bulletId += 1
      game.lastShotAt = game.elapsed
      game.recoilAmount = 1
      game.muzzleAmount = 1
      game.status = '射击中'
      spawnParticles(spawnPosition, '#6cefff', 4)
      emitHud()
    }

    function startGame() {
      clearEntities()
      popupTimeoutsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId))
      popupTimeoutsRef.current = []
      startTransition(() => setPopups([]))

      game.combo = 0
      game.elapsed = 0
      game.lastShotAt = -Infinity
      game.muzzleAmount = 0
      game.nextSpawnAt = randomBetween(0.4, 1.0)
      game.phase = 'playing'
      game.recoilAmount = 0
      game.score = 0
      game.status = '开始清靶'
      game.timeLeft = GAME_DURATION
      pointerWorld.set(0, turretOrigin.y + 220, 0)
      syncTurretFromPointer()
      emitHud(true)
    }

    function pauseGame(status = '训练已暂停') {
      if (game.phase !== 'playing') {
        return
      }

      game.phase = 'paused'
      game.status = status
      emitHud(true)
    }

    function resumeGame() {
      if (game.phase !== 'paused') {
        return
      }

      game.phase = 'playing'
      game.status = '继续训练'
      emitHud(true)
    }

    function finishGame(status = '训练结束') {
      if (game.phase === 'ended') {
        return
      }

      game.phase = 'ended'
      game.timeLeft = 0
      clearGroup(bulletLayer)
      bullets.length = 0
      clearGroup(targetLayer)
      targets.length = 0

      if (game.score > game.bestScore) {
        game.bestScore = Math.round(game.score)
        try {
          window.localStorage.setItem(BEST_SCORE_KEY, String(game.bestScore))
        } catch {
          // Ignore storage failures.
        }
      }

      game.status = status
      emitHud(true)
    }

    function registerHit(targetIndex: number, bulletIndex: number) {
      const target = targets[targetIndex]
      const spec = target.spec
      const isTrap = Boolean(spec.trap)

      removeBullet(bulletIndex)

      if (isTrap) {
        game.score += spec.score
        resetCombo('误击陷阱')
        setPopup(`${spec.score}`, target.position, false, true)
        spawnParticles(target.position, '#ff7d92', 12)
      } else {
        game.combo += 1
        const multiplier = getMultiplier(game.combo)
        const gained = Math.round(spec.score * multiplier)
        game.score += gained
        game.status = `${spec.label} 命中`
        setPopup(`+${gained}`, target.position, true)
        spawnParticles(target.position, spec.glow, 12)
      }

      removeTarget(targetIndex)
      emitHud(true)
    }

    function updateTargets(delta: number) {
      for (let index = targets.length - 1; index >= 0; index -= 1) {
        const target = targets[index]
        target.age += delta
        target.group.rotation.z += target.spin * delta

        const pulse = 1 + Math.sin(game.elapsed * target.spec.pulse + target.seed) * 0.05
        target.group.scale.setScalar(pulse)

        if (target.accent) {
          target.accent.rotation.z -= target.spin * delta * 1.8
        }

        const lifeRatio = target.age / target.life
        const urgentRatio = THREE.MathUtils.clamp((lifeRatio - 0.65) / 0.35, 0, 1)
        const flash = urgentRatio > 0
          ? 0.48 + Math.abs(Math.sin(game.elapsed * 18 + target.seed)) * 0.52
          : 1

        for (const handle of target.materials) {
          handle.material.opacity = handle.baseOpacity * flash
        }

        if (target.age >= target.life) {
          spawnParticles(target.position, '#ffd580', 8)
          removeTarget(index)
          resetCombo('漏掉靶子')
          emitHud(true)
        }
      }
    }

    function updateBullets(delta: number) {
      const xBound = size.width / 2 + 90
      const yBound = size.height / 2 + 90

      for (let bulletIndex = bullets.length - 1; bulletIndex >= 0; bulletIndex -= 1) {
        const bullet = bullets[bulletIndex]
        bullet.age += delta
        bullet.position.addScaledVector(bullet.velocity, delta)
        bullet.group.position.set(bullet.position.x, bullet.position.y, 0.2)

        let hitRegistered = false

        for (let targetIndex = targets.length - 1; targetIndex >= 0; targetIndex -= 1) {
          const target = targets[targetIndex]
          if (
            bullet.position.distanceTo(target.position) <=
            bullet.radius + target.radius
          ) {
            registerHit(targetIndex, bulletIndex)
            hitRegistered = true
            break
          }
        }

        if (hitRegistered) {
          continue
        }

        const outOfBounds =
          bullet.position.x < -xBound ||
          bullet.position.x > xBound ||
          bullet.position.y < -yBound ||
          bullet.position.y > yBound

        if (outOfBounds) {
          removeBullet(bulletIndex)
          resetCombo('射空')
          emitHud(true)
        }
      }
    }

    function updateParticles(delta: number) {
      for (let index = particles.length - 1; index >= 0; index -= 1) {
        const particle = particles[index]
        particle.age += delta
        particle.velocity.multiplyScalar(1 - particle.drag * delta * 0.2)
        particle.mesh.position.x += particle.velocity.x * delta
        particle.mesh.position.y += particle.velocity.y * delta
        particle.mesh.rotation.z += particle.spin * delta
        const lifeRatio = 1 - particle.age / particle.life
        const material = particle.mesh.material

        if (material instanceof THREE.MeshBasicMaterial) {
          material.opacity = Math.max(0, lifeRatio) * 0.85
        }

        if (particle.age >= particle.life) {
          removeParticle(index)
        }
      }
    }

    function animate() {
      if (disposed) {
        return
      }

      const now = performance.now()
      const delta = Math.min((now - lastFrameTime) / 1000, 0.04)
      lastFrameTime = now

      if (scanLine) {
        scanLine.position.y = -size.height * 0.18 + Math.sin(now * 0.0014) * size.height * 0.18
      }

      if (game.phase === 'playing') {
        game.elapsed += delta
        game.timeLeft = Math.max(0, GAME_DURATION - game.elapsed)

        if (targets.length < MAX_TARGETS && game.elapsed >= game.nextSpawnAt) {
          spawnTarget()
          game.nextSpawnAt = game.elapsed + randomBetween(0.4, 1.0)
        }

        updateTargets(delta)
        updateBullets(delta)
        updateParticles(delta)

        game.recoilAmount = THREE.MathUtils.damp(game.recoilAmount, 0, 10, delta)
        game.muzzleAmount = THREE.MathUtils.damp(game.muzzleAmount, 0, 18, delta)
        muzzleFlash.material.opacity = game.muzzleAmount * 0.7
        muzzleFlash.scale.setScalar(1 + game.muzzleAmount * 0.6)

        if (game.timeLeft <= 0) {
          finishGame()
        }
      } else if (game.phase === 'paused') {
        muzzleFlash.material.opacity = 0
      } else {
        game.recoilAmount = THREE.MathUtils.damp(game.recoilAmount, 0, 8, delta)
        game.muzzleAmount = THREE.MathUtils.damp(game.muzzleAmount, 0, 12, delta)
        muzzleFlash.material.opacity = game.muzzleAmount * 0.45
        muzzleFlash.scale.setScalar(1 + game.muzzleAmount * 0.4)
        updateParticles(delta)
      }

      syncTurretFromPointer()
      renderer.render(scene, camera)
      emitHud()
      frameId = window.requestAnimationFrame(animate)
    }

    function updatePointer(clientX: number, clientY: number) {
      const rect = host.getBoundingClientRect()
      const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1
      const ndcY = -(((clientY - rect.top) / rect.height) * 2 - 1)
      const vector = new THREE.Vector3(ndcX, ndcY, 0)
      vector.unproject(camera)
      pointerWorld.set(vector.x, vector.y, 0)
      syncTurretFromPointer()
    }

    function handlePointerMove(event: PointerEvent) {
      updatePointer(event.clientX, event.clientY)
    }

    function handlePointerDown(event: PointerEvent) {
      updatePointer(event.clientX, event.clientY)
      fireBullet()
    }

    function handleFullscreenChange() {
      resize()

      const stage = stageRef.current
      if (game.phase === 'playing' && stage && document.fullscreenElement !== stage) {
        pauseGame('已退出全屏，游戏暂停')
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') {
        return
      }

      const stage = stageRef.current
      if (game.phase === 'playing' && document.fullscreenElement !== stage) {
        pauseGame('已暂停，选择继续或结束')
      }
    }

    resize()
    animate()

    window.addEventListener('resize', resize)
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    window.addEventListener('keydown', handleKeyDown)
    host.addEventListener('pointermove', handlePointerMove)
    host.addEventListener('pointerdown', handlePointerDown)

    engineRef.current = {
      end: finishGame,
      pause: pauseGame,
      resume: resumeGame,
      start: startGame,
    }
    emitHud(true)

    return () => {
      disposed = true
      engineRef.current = null
      window.removeEventListener('resize', resize)
      document.removeEventListener('fullscreenchange', handleFullscreenChange)
      window.removeEventListener('keydown', handleKeyDown)
      host.removeEventListener('pointermove', handlePointerMove)
      host.removeEventListener('pointerdown', handlePointerDown)
      popupTimeoutsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId))
      popupTimeoutsRef.current = []
      window.cancelAnimationFrame(frameId)
      clearEntities()
      clearGroup(uiLayer)
      clearGroup(backdropLayer)
      disposeObject3D(turretGroup)
      renderer.dispose()
      host.removeChild(renderer.domElement)
    }
  }, [])

  async function handleLaunch() {
    const stage = stageRef.current

    if (stage && document.fullscreenElement !== stage) {
      try {
        await stage.requestFullscreen()
      } catch {
        // If fullscreen is blocked, still start the session.
      }
    }

    if (hud.phase === 'paused') {
      engineRef.current?.resume()
      return
    }

    engineRef.current?.start()
  }

  async function handleEndGame() {
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen()
      } catch {
        // Ignore exit failures and still end the session.
      }
    }

    engineRef.current?.end('主动结束本局')
  }

  return (
    <section className="snapshot-shell">
      <div className="snapshot-copy">
        <p className="snapshot-kicker">THREE.JS / TIMED RANGE</p>
        <h1>Snap Shot</h1>
        <p className="snapshot-summary">
          固定底部炮台，鼠标瞄准后清除随机靶。当前初版包含 60 秒限时、
          五类靶子、连击倍率、粒子命中反馈和本地最高分记录。
        </p>
      </div>

      <div className="snapshot-stage-wrap">
        <div className="snapshot-hud">
          <div className="stat-card emphasis">
            <span className="stat-label">Score</span>
            <strong>{hud.score}</strong>
          </div>
          <div className="stat-card">
            <span className="stat-label">Time</span>
            <strong>{hud.timeLeft.toFixed(1)}s</strong>
          </div>
          <div className="stat-card">
            <span className="stat-label">Combo</span>
            <strong>{hud.combo}</strong>
          </div>
          <div className="stat-card">
            <span className="stat-label">Multiplier</span>
            <strong>x{hud.multiplier}</strong>
          </div>
          <div className="stat-card">
            <span className="stat-label">Targets</span>
            <strong>{hud.activeTargets}</strong>
          </div>
          <div className="stat-card">
            <span className="stat-label">Best</span>
            <strong>{hud.bestScore}</strong>
          </div>
        </div>

        <div className="snapshot-stage" ref={stageRef}>
          <div
            className="snapshot-canvas"
            ref={mountRef}
          />

          <div className="popup-layer">
            {popups.map((popup) => (
              <div
                className={`score-popup${popup.positive ? ' positive' : ' negative'}${popup.warning ? ' warning' : ''}`}
                key={popup.id}
                style={{ left: popup.x, top: popup.y }}
              >
                {popup.text}
              </div>
            ))}
          </div>

          <div className="stage-overlay top">
            <span className="stage-badge">
              {hud.phase === 'playing'
                ? 'LIVE RANGE'
                : hud.phase === 'paused'
                  ? 'PAUSED'
                  : hud.phase === 'ended'
                    ? 'SESSION COMPLETE'
                    : 'TRAINING READY'}
            </span>
            <p>{hud.status}</p>
          </div>

          {hud.phase !== 'playing' && (
            <div className="stage-overlay center">
              <div className="overlay-card">
                <p className="overlay-kicker">
                  {hud.phase === 'ended'
                    ? 'SESSION COMPLETE'
                    : hud.phase === 'paused'
                      ? 'PAUSED'
                      : 'TARGET RANGE'}
                </p>
                <h2>
                  {hud.phase === 'ended'
                    ? `最终得分 ${hud.score}`
                    : hud.phase === 'paused'
                      ? '训练已暂停'
                      : '60 秒速射训练'}
                </h2>
                <p>
                  {hud.phase === 'ended'
                    ? `当前版本为 60 秒限时模式，本地最高分 ${hud.bestScore}。`
                    : hud.phase === 'paused'
                      ? '按 Esc 或退出全屏会暂停。继续训练会尝试重新进入全屏，结束本局会立刻结算当前分数。'
                      : '移动鼠标瞄准，点击发射。射空、漏靶或误击陷阱都会清空连击。'}
                </p>
                <div className="overlay-actions">
                  {hud.phase === 'paused' ? (
                    <>
                      <button
                        className="launch-button"
                        onClick={handleLaunch}
                        type="button"
                      >
                        继续训练
                      </button>
                      <button
                        className="launch-button secondary"
                        onClick={handleEndGame}
                        type="button"
                      >
                        结束本局
                      </button>
                    </>
                  ) : (
                    <button
                      className="launch-button"
                      onClick={handleLaunch}
                      type="button"
                    >
                      {hud.phase === 'ended' ? '重新开始' : '启动训练'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="snapshot-panels">
        <div className="info-panel">
          <p className="panel-title">Controls</p>
          <p>鼠标移动瞄准，左键开火。按 Esc 或退出全屏会暂停，并弹出继续/结束选项。</p>
        </div>

        <div className="info-panel">
          <p className="panel-title">Target Intel</p>
          <div className="legend-grid">
            {TARGET_ORDER.map((kind) => {
              const spec = TARGET_SPECS[kind]
              return (
                <div className="legend-item" key={kind}>
                  <span
                    className="legend-dot"
                    style={{ background: `radial-gradient(circle, ${spec.glow} 0%, ${spec.color} 65%, transparent 100%)` }}
                  />
                  <div>
                    <strong>
                      {spec.label} {spec.score > 0 ? `+${spec.score}` : spec.score}
                    </strong>
                    <p>{spec.description}</p>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        <div className="info-panel compact">
          <p className="panel-title">Combo Rule</p>
          <p>1-4 连击 x1</p>
          <p>5-9 连击 x1.5</p>
          <p>10+ 连击 x2</p>
        </div>
      </div>
    </section>
  )
}
