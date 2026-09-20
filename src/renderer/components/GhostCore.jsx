import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'

// Palette pulled straight from styles.css (--cyan/--violet/--magenta) so the Core matches the HUD.
const CYAN = new THREE.Color(0x00e6ff)
const VIOLET = new THREE.Color(0x7c5cff)
const MAGENTA = new THREE.Color(0xff45c0)
const HOT = new THREE.Color(0x9fe8ff)

// Probe the GPU once per session: software renderers (Crostini's SwiftShader/llvmpipe) can't afford
// the glass tier's transmission + bloom, so we transparently fall back to the cheap fresnel tier.
let _tier = null
function resolveTier() {
  if (_tier) return _tier
  try {
    const c = document.createElement('canvas')
    const gl = c.getContext('webgl') || c.getContext('experimental-webgl')
    if (!gl) return (_tier = 'lite')
    const dbg = gl.getExtension('WEBGL_debug_renderer_info')
    const r = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : ''
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    _tier = !r ? 'high' : /swiftshader|llvmpipe|softpipe|software|basic render|microsoft|mesa offscreen/i.test(r) ? 'lite' : 'high'
  } catch {
    _tier = 'high'
  }
  return _tier
}

// The Ghost-Prime Core — a procedural holographic gem in three.js. The high tier's geometry (faceted
// smoked-glass body, metal edge bezels + vertex balls, engraved circuit traces, faceted nucleus) was
// hand-built in ai-core/index.html; here it's wired for the app: transparent, container-sized, with
// the glow/emission/bloom + `active` reactivity added on top (cyan standby → charged magenta).
//
//   quality="auto" (default) — probe the GPU: glass on real hardware, fresnel on software GL.
//   quality="high"           — force the full crystal: transmission + traces + env + UnrealBloom.
//   quality="lite"           — force the fresnel shell (no transmission/bloom).
//
// Renders on a transparent canvas sized to its container, caps to `fps`, pauses while the window is
// hidden, survives GPU context loss, honours prefers-reduced-motion, and fully disposes on unmount.
export default function GhostCore({ active = false, height = 150, quality = 'auto', fps = 30, className = '' }) {
  const mountRef = useRef(null)
  const activeRef = useRef(active)
  activeRef.current = active

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    const tier = quality === 'auto' ? resolveTier() : quality
    const isHigh = tier === 'high'
    mount.dataset.tier = tier

    let width = mount.clientWidth || 240
    const h = height

    let renderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: isHigh, alpha: true, powerPreference: 'low-power' })
    } catch {
      return // No WebGL context — fail silent, leave an empty slot.
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isHigh ? 1.25 : 1.5))
    renderer.setSize(width, h)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.1
    renderer.domElement.style.display = 'block'
    mount.appendChild(renderer.domElement)

    const FOV = isHigh ? 34 : 45
    const scene = new THREE.Scene() // transparent — no scene.background
    const camera = new THREE.PerspectiveCamera(FOV, width / h, 0.1, 100)
    camera.position.set(2.6, 1.5, 5.2)
    camera.lookAt(0, 0, 0)

    const core = new THREE.Group() // the spinner (rotation + float)
    scene.add(core)
    const nucleus = new THREE.Group() // tumbles independently inside the gem
    core.add(nucleus)

    // Disposables we tear down on unmount.
    const geos = []
    const mats = []
    let composer = null
    let bloom = null
    let pmrem = null
    let envTex = null

    // Per-frame reactive refs (set by whichever tier builds).
    let glowMat = null // lite
    let tracesMat = null // high — the glowing circuitry
    let nucMat = null
    let rimLight = null
    let accentLight = null

    if (isHigh) {
      pmrem = new THREE.PMREMGenerator(renderer)
      const room = new RoomEnvironment() // only needed to bake the env map — free its geometry/materials right away
      envTex = pmrem.fromScene(room, 0.04).texture
      room.dispose?.()
      scene.environment = envTex

      scene.add(new THREE.HemisphereLight(0xffffff, 0x2a3550, 0.5))
      const key = new THREE.DirectionalLight(0xbfe9ff, 1.4)
      key.position.set(3.2, 5, 4)
      const fill = new THREE.DirectionalLight(VIOLET.clone(), 0.5)
      fill.position.set(-4, 1.5, 2)
      rimLight = new THREE.DirectionalLight(CYAN.clone(), 1.2)
      rimLight.position.set(-1, 2, -4.5)
      scene.add(key, fill, rimLight)

      // ── geometry of the core (ported from ai-core/index.html) ──
      const V = THREE.Vector3
      const Htop = 1.45, Hbot = 1.7, R = 0.82 // elongated octahedron (vertical > width)
      const top = new V(0, Htop, 0), bottom = new V(0, -Hbot, 0)
      const e0 = new V(R, 0, 0), e1 = new V(0, 0, R), e2 = new V(-R, 0, 0), e3 = new V(0, 0, -R)
      const facesArr = [
        [top, e0, e1], [top, e1, e2], [top, e2, e3], [top, e3, e0],
        [bottom, e1, e0], [bottom, e2, e1], [bottom, e3, e2], [bottom, e0, e3]
      ]
      const edgesArr = [
        [top, e0], [top, e1], [top, e2], [top, e3],
        [bottom, e0], [bottom, e1], [bottom, e2], [bottom, e3],
        [e0, e1], [e1, e2], [e2, e3], [e3, e0]
      ]
      const vertsArr = [top, bottom, e0, e1, e2, e3]

      const tube = (p1, p2, r, seg = 10) => {
        const dir = new V().subVectors(p2, p1), len = dir.length()
        const g = new THREE.CylinderGeometry(r, r, len, seg, 1, false)
        g.translate(0, len / 2, 0)
        const q = new THREE.Quaternion().setFromUnitVectors(new V(0, 1, 0), dir.clone().normalize())
        const m = new THREE.Matrix4().makeRotationFromQuaternion(q)
        m.setPosition(p1)
        g.applyMatrix4(m)
        return g
      }
      const ball = (p, r) => {
        const g = new THREE.SphereGeometry(r, 12, 10)
        g.translate(p.x, p.y, p.z)
        return g
      }

      const model = new THREE.Group()
      core.add(model)

      // smoked-glass gem (flat-shaded for crisp facets)
      const gemPos = []
      for (const [a, b, c] of facesArr) gemPos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z)
      const gemGeo = new THREE.BufferGeometry()
      gemGeo.setAttribute('position', new THREE.Float32BufferAttribute(gemPos, 3))
      gemGeo.computeVertexNormals()
      geos.push(gemGeo)
      const glass = new THREE.MeshPhysicalMaterial({
        color: 0x1c1f25, metalness: 0, roughness: 0.06, transmission: 0.82, ior: 1.6, thickness: 2.2,
        attenuationColor: new THREE.Color(0x090b10), attenuationDistance: 1.05,
        clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 1.25, flatShading: true
      })
      mats.push(glass)
      model.add(new THREE.Mesh(gemGeo, glass))

      // metal bezels along every seam, capped at each vertex (merged → one draw call)
      const bezelGeos = []
      for (const [a, b] of edgesArr) bezelGeos.push(tube(a, b, 0.026))
      for (const v of vertsArr) bezelGeos.push(ball(v, 0.046))
      const bezelGeo = mergeGeometries(bezelGeos)
      bezelGeos.forEach((g) => g.dispose())
      geos.push(bezelGeo)
      const bezelMat = new THREE.MeshPhysicalMaterial({ color: 0x43474f, metalness: 1, roughness: 0.42, envMapIntensity: 1, clearcoat: 0.3 })
      mats.push(bezelMat)
      model.add(new THREE.Mesh(bezelGeo, bezelMat))

      // engraved circuit traces — the glowing, reactive element
      const traceGeos = []
      for (const [A, B, C] of facesArr) {
        const ctr = new V().add(A).add(B).add(C).multiplyScalar(1 / 3)
        let n = new V().subVectors(B, A).cross(new V().subVectors(C, A)).normalize()
        if (n.dot(ctr) < 0) n.negate()
        const off = n.clone().multiplyScalar(0.007)
        const ctrO = ctr.clone().add(off)
        const inset = [A, B, C].map((p) => p.clone().lerp(ctr, 0.17).add(off))
        for (let i = 0; i < 3; i++) {
          traceGeos.push(tube(inset[i], inset[(i + 1) % 3], 0.0085))
          const mid = inset[i].clone().lerp(ctrO, 0.55)
          traceGeos.push(tube(inset[i], mid, 0.0065))
          traceGeos.push(ball(mid, 0.016))
        }
        traceGeos.push(ball(ctrO, 0.022))
      }
      const tracesGeo = mergeGeometries(traceGeos)
      traceGeos.forEach((g) => g.dispose())
      geos.push(tracesGeo)
      tracesMat = new THREE.MeshStandardMaterial({ color: 0x0a0e14, emissive: CYAN.clone(), emissiveIntensity: 1.8, metalness: 0.6, roughness: 0.3 })
      mats.push(tracesMat)
      model.add(new THREE.Mesh(tracesGeo, tracesMat))

      // faceted nucleus — metal + reactive emission
      const nucGeo = new THREE.OctahedronGeometry(0.34, 0)
      geos.push(nucGeo)
      nucMat = new THREE.MeshPhysicalMaterial({
        color: 0x20262e, metalness: 1, roughness: 0.16, flatShading: true,
        emissive: CYAN.clone(), emissiveIntensity: 0.6, envMapIntensity: 1.3
      })
      mats.push(nucMat)
      const nucMesh = new THREE.Mesh(nucGeo, nucMat)
      nucMesh.scale.set(1, 1.25, 1)
      nucleus.add(nucMesh)
      accentLight = new THREE.PointLight(CYAN.clone(), 1.2, 3)
      nucleus.add(accentLight)

      // recenter vertically so it spins about its middle, then frame it three-quarter
      const box0 = new THREE.Box3().setFromObject(model)
      const cy = box0.getCenter(new V()).y
      const size = box0.getSize(new V())
      model.position.y -= cy
      nucleus.position.y -= cy
      const maxDim = Math.max(size.x, size.y, size.z)
      const fitDist = (maxDim / (2 * Math.tan((FOV * Math.PI) / 360))) * 1.5
      camera.position.set(0.5, 0.32, 0.95).normalize().multiplyScalar(fitDist)
      camera.lookAt(0, 0, 0)

      composer = new EffectComposer(renderer)
      composer.setSize(width, h)
      composer.addPass(new RenderPass(scene, camera))
      bloom = new UnrealBloomPass(new THREE.Vector2(width, h), 0.6, 0.45, 0.8)
      composer.addPass(bloom)
      composer.addPass(new OutputPass())
    } else {
      // ── Lite tier: fresnel shell, no transmission/bloom — cheap and always smooth. ──
      const gemGeo = new THREE.OctahedronGeometry(1.2, 0)
      gemGeo.scale(1, 1.45, 1)
      gemGeo.computeVertexNormals()
      geos.push(gemGeo)

      const gemMat = new THREE.MeshStandardMaterial({
        color: 0x14233f, metalness: 0.25, roughness: 0.35, flatShading: true,
        transparent: true, opacity: 0.92, emissive: CYAN.clone(), emissiveIntensity: 0.12
      })
      mats.push(gemMat)
      core.add(new THREE.Mesh(gemGeo, gemMat))
      const wireMat = new THREE.MeshBasicMaterial({ color: CYAN.clone(), wireframe: true, transparent: true, opacity: 0.3 })
      mats.push(wireMat)
      core.add(new THREE.Mesh(gemGeo, wireMat))

      glowMat = new THREE.ShaderMaterial({
        transparent: true, blending: THREE.AdditiveBlending, side: THREE.BackSide, depthWrite: false,
        uniforms: { uA: { value: CYAN.clone() }, uB: { value: VIOLET.clone() }, uStr: { value: 0.85 } },
        vertexShader: `varying vec3 vN; varying vec3 vV;
          void main(){ vN=normalize(normalMatrix*normal); vec4 mv=modelViewMatrix*vec4(position,1.0); vV=normalize(-mv.xyz); gl_Position=projectionMatrix*mv; }`,
        fragmentShader: `varying vec3 vN; varying vec3 vV; uniform vec3 uA; uniform vec3 uB; uniform float uStr;
          void main(){ float f=pow(1.0-max(dot(normalize(vN),normalize(vV)),0.0),2.4); gl_FragColor=vec4(mix(uA,uB,f), f*uStr); }`
      })
      mats.push(glowMat)
      const glow = new THREE.Mesh(gemGeo, glowMat)
      glow.scale.setScalar(1.12)
      core.add(glow)

      const nucGeo = new THREE.IcosahedronGeometry(0.4, 0)
      geos.push(nucGeo)
      nucMat = new THREE.MeshBasicMaterial({ color: CYAN.clone(), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending })
      mats.push(nucMat)
      nucleus.add(new THREE.Mesh(nucGeo, nucMat))

      scene.add(new THREE.AmbientLight(0x33486b, 0.85))
      const key = new THREE.DirectionalLight(CYAN.clone(), 2.2)
      key.position.set(-2, 3, 2)
      const fill = new THREE.DirectionalLight(VIOLET.clone(), 1.8)
      fill.position.set(3, -2, 1)
      scene.add(key, fill)
    }

    const renderFrame = () => (composer ? composer.render() : renderer.render(scene, camera))

    let raf = 0
    let mix = 0 // eased 0→1 idle→active, drives the whole transition
    let lastDraw = 0
    const start = performance.now()
    const frameMin = 1000 / Math.max(1, fps)
    const tmpA = new THREE.Color()
    const tmpB = new THREE.Color()

    function frame(now) {
      raf = reduce ? 0 : requestAnimationFrame(frame)
      if (lastDraw && now - lastDraw < frameMin) return // FPS cap — skip this tick
      const dt = Math.min(0.05, lastDraw ? (now - lastDraw) / 1000 : 0.016)
      lastDraw = now
      const t = (now - start) / 1000
      const target = activeRef.current ? 1 : 0
      mix += (target - mix) * Math.min(1, dt * 4)

      core.rotation.y += dt * (0.26 + mix * 0.34)
      core.rotation.x = Math.sin(t * 0.4) * 0.12
      core.position.y = Math.sin(t * 0.8) * 0.06
      nucleus.rotation.y -= dt * 0.9
      nucleus.rotation.x += dt * 0.5
      renderer.toneMappingExposure = 1.1 + mix * 0.14 // lift brightness when thinking

      // Nucleus "heartbeat" — faster + wider as it energises.
      const p = (0.4 + mix * 0.45) + Math.sin(t * (2.2 + mix * 3)) * (0.16 + mix * 0.34)

      if (isHigh) {
        tmpA.copy(CYAN).lerp(MAGENTA, mix)
        tracesMat.emissive.copy(tmpA)
        tracesMat.emissiveIntensity = 1.6 + mix * 1.6 + p * 0.6
        nucMat.emissive.copy(tmpB.copy(CYAN).lerp(HOT, mix))
        nucMat.emissiveIntensity = 0.5 + mix * 1.0 + p * 0.4
        accentLight.color.copy(tmpA)
        accentLight.intensity = 1.1 + mix * 1.2
        rimLight.color.copy(tmpA)
        bloom.strength = 0.55 + mix * 0.4 + p * 0.12
      } else {
        nucleus.scale.setScalar(0.85 + p * 0.3)
        nucMat.opacity = 0.5 + p * 0.4
        nucMat.color.copy(tmpA.copy(CYAN).lerp(HOT, mix))
        glowMat.uniforms.uStr.value = 0.5 + mix * 0.3 + p * 0.25
        glowMat.uniforms.uB.value.copy(tmpB.copy(VIOLET).lerp(MAGENTA, mix))
      }

      renderFrame()
    }

    if (reduce) frame(start + 700)
    else raf = requestAnimationFrame(frame)

    const resume = () => {
      if (reduce || document.hidden || raf) return
      lastDraw = 0
      raf = requestAnimationFrame(frame)
    }
    const pause = () => {
      if (raf) { cancelAnimationFrame(raf); raf = 0 }
    }

    // Don't burn cycles while the window is hidden.
    const onVis = () => (document.hidden ? pause() : resume())
    document.addEventListener('visibilitychange', onVis)

    // Survive a GPU context loss (Crostini's virtio-gpu can drop the process) instead of freezing.
    const canvas = renderer.domElement
    const onLost = (e) => { e.preventDefault(); pause() }
    const onRestored = () => resume()
    canvas.addEventListener('webglcontextlost', onLost, false)
    canvas.addEventListener('webglcontextrestored', onRestored, false)

    const ro = new ResizeObserver(() => {
      const nw = mount.clientWidth
      if (!nw || nw === width) return
      width = nw
      renderer.setSize(width, h)
      composer?.setSize(width, h)
      bloom?.setSize(width, h)
      camera.aspect = width / h
      camera.updateProjectionMatrix()
    })
    ro.observe(mount)

    return () => {
      pause()
      document.removeEventListener('visibilitychange', onVis)
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      ro.disconnect()
      geos.forEach((g) => g.dispose())
      mats.forEach((m) => m.dispose())
      bloom?.dispose?.()
      composer?.dispose?.()
      envTex?.dispose?.()
      pmrem?.dispose?.()
      // Release the GL context now rather than when the detached canvas is GC'd: the hero core remounts
      // on every new chat, and Chromium evicts the OLDEST context (the long-lived panel indicator)
      // once too many are alive.
      try {
        renderer.forceContextLoss()
      } catch {}
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [height, quality, fps])

  return <div ref={mountRef} className={`ghost-core ${className}`} style={{ height }} aria-hidden="true" />
}
