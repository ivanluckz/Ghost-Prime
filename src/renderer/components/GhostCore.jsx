import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
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

// The Ghost-Prime Core — a procedural holographic gem in three.js. `active` (wire it to the Activity
// panel's busy flag) smoothly energises it: spins up, the etch + nucleus flare brighter, the bloom
// swells, exposure lifts, and the accents shift cyan → magenta — so the Core visibly "thinks".
//
//   quality="auto" (default) — probe the GPU: glass on real hardware, fresnel on software GL.
//   quality="high"           — force real glass: MeshPhysical transmission + env + UnrealBloom.
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
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.15
    renderer.domElement.style.display = 'block'
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene() // transparent — no scene.background
    const camera = new THREE.PerspectiveCamera(45, width / h, 0.1, 100)
    camera.position.set(2.6, 1.5, 5.2)
    camera.lookAt(0, 0, 0)

    const core = new THREE.Group()
    scene.add(core)
    const nucleus = new THREE.Group()
    core.add(nucleus)

    // Disposables we tear down on unmount.
    const geos = []
    const mats = []
    let composer = null
    let bloom = null
    let pmrem = null
    let envTex = null

    // Shared faceted-diamond body: an octahedron stretched on Y into a brilliant-cut silhouette.
    const gemGeo = new THREE.OctahedronGeometry(1.2, 0)
    gemGeo.scale(1, 1.45, 1)
    gemGeo.computeVertexNormals()
    geos.push(gemGeo)

    // Per-frame reactive refs (set by whichever tier builds).
    let etchMat = null
    let nucMat = null
    let glowMat = null
    let rimLight = null
    let accentLight = null

    if (isHigh) {
      // Studio-grade reflections/refractions from a tiny baked room.
      pmrem = new THREE.PMREMGenerator(renderer)
      envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
      scene.environment = envTex

      scene.add(new THREE.AmbientLight(0xffffff, 0.35))
      const key = new THREE.DirectionalLight(0xbfe9ff, 1.8)
      key.position.set(5, 8, 6)
      const fill = new THREE.DirectionalLight(VIOLET.clone(), 1.0)
      fill.position.set(-5, 2, 4)
      rimLight = new THREE.DirectionalLight(CYAN.clone(), 1.6)
      rimLight.position.set(0, 2, -5)
      scene.add(key, fill, rimLight)

      const glass = new THREE.MeshPhysicalMaterial({
        color: 0x0b1320, metalness: 0, roughness: 0.05, transmission: 0.95, thickness: 1.5,
        ior: 1.5, envMapIntensity: 1.4, clearcoat: 1.0, clearcoatRoughness: 0.0, side: THREE.DoubleSide
      })
      mats.push(glass)
      core.add(new THREE.Mesh(gemGeo, glass))

      // Titanium bezels + glowing etch tubes traced along every facet seam.
      const edges = new THREE.EdgesGeometry(gemGeo)
      const ep = edges.attributes.position.array
      const bezelMat = new THREE.MeshStandardMaterial({ color: 0x12161c, metalness: 1.0, roughness: 0.4, envMapIntensity: 1.4 })
      etchMat = new THREE.MeshStandardMaterial({ color: CYAN.clone(), emissive: CYAN.clone(), emissiveIntensity: 2.6, metalness: 0.5, roughness: 0.2 })
      mats.push(bezelMat, etchMat)
      const bezelG = new THREE.Group()
      const etchG = new THREE.Group()
      for (let i = 0; i < ep.length; i += 6) {
        const v1 = new THREE.Vector3(ep[i], ep[i + 1], ep[i + 2])
        const v2 = new THREE.Vector3(ep[i + 3], ep[i + 4], ep[i + 5])
        const curve = new THREE.LineCurve3(v1, v2)
        const bz = new THREE.TubeGeometry(curve, 1, 0.035, 6, false)
        const et = new THREE.TubeGeometry(curve, 1, 0.009, 6, false)
        geos.push(bz, et)
        bezelG.add(new THREE.Mesh(bz, bezelMat))
        etchG.add(new THREE.Mesh(et, etchMat))
      }
      edges.dispose()
      etchG.scale.setScalar(1.025)
      core.add(bezelG, etchG)

      // Metallic nucleus with an inner light that bleeds through the glass.
      const nucGeo = new THREE.IcosahedronGeometry(0.26, 0)
      geos.push(nucGeo)
      nucMat = new THREE.MeshPhysicalMaterial({
        color: 0x050505, metalness: 1.0, roughness: 0.1, clearcoat: 1.0,
        emissive: CYAN.clone(), emissiveIntensity: 0.6, envMapIntensity: 2.5
      })
      mats.push(nucMat)
      nucleus.add(new THREE.Mesh(nucGeo, nucMat))
      accentLight = new THREE.PointLight(CYAN.clone(), 1.4, 3)
      nucleus.add(accentLight)

      composer = new EffectComposer(renderer)
      composer.setSize(width, h)
      composer.addPass(new RenderPass(scene, camera))
      bloom = new UnrealBloomPass(new THREE.Vector2(width, h), 0.5, 0.4, 0.82)
      composer.addPass(bloom)
      composer.addPass(new OutputPass())
    } else {
      // ── Lite tier: fresnel shell, no transmission/bloom — cheap and always smooth. ──
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
      core.rotation.x = Math.sin(t * 0.4) * 0.14
      core.position.y = Math.sin(t * 0.8) * 0.08
      nucleus.rotation.y -= dt * 1.2
      nucleus.rotation.x += dt * 0.8
      renderer.toneMappingExposure = 1.15 + mix * 0.12 // lift brightness when thinking

      // Nucleus "heartbeat" — faster + wider as it energises.
      const p = (0.4 + mix * 0.45) + Math.sin(t * (2.2 + mix * 3)) * (0.16 + mix * 0.34)

      if (isHigh) {
        tmpA.copy(CYAN).lerp(MAGENTA, mix)
        etchMat.color.copy(tmpA)
        etchMat.emissive.copy(tmpA)
        etchMat.emissiveIntensity = 2.4 + mix * 1.4 + p * 0.6
        nucMat.emissive.copy(tmpB.copy(CYAN).lerp(HOT, mix))
        nucMat.emissiveIntensity = 0.5 + mix * 0.9 + p * 0.4
        accentLight.color.copy(tmpA)
        accentLight.intensity = 1.3 + mix * 1.1
        rimLight.color.copy(tmpA)
        bloom.strength = 0.5 + mix * 0.35 + p * 0.12
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
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [height, quality, fps])

  return <div ref={mountRef} className={`ghost-core ${className}`} style={{ height }} aria-hidden="true" />
}
