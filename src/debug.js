import GUI from 'lil-gui'
import Stats from 'stats.js'

/**
 * Панель под #debug в URL. Импортируется динамически, чтобы lil-gui и stats не попадали
 * в чанк, который грузит обычный посетитель.
 *
 * Вызывать до play(): счётчик кадров навешивается подменой hero.tick, а play() отдаёт
 * ссылку на него в setAnimationLoop.
 */
export function attachDebug(hero)
{
    const stats = new Stats()
    document.body.appendChild(stats.dom)

    const tick = hero.tick
    hero.tick = () =>
    {
        stats.begin()
        tick()
        stats.end()
    }

    const gui = new GUI({ width: 320 })
    const u = hero.uniforms

    const spheres = gui.addFolder('Spheres')
    spheres.add(u.radius, 'value', 0, 0.5, 0.001).name('radius')
    spheres.add(u.contactRadius, 'value', 0, 0.5, 0.001).name('contactRadius')
    spheres.add(u.gravityStrength, 'value', 0, 0.1, 0.001).name('gravityStrength')
    spheres.add(u.impactDamping, 'value', 0, 1, 0.001).name('impactDamping')
    spheres.add(u.generalDamping, 'value', 0, 1, 0.01).name('generalDamping')

    const heat = gui.addFolder('Heat')
    heat.add(u.heatDamping, 'value', 0, 10, 0.1).name('heatDamping')
    heat.add(u.heatImpactStrength, 'value', 0, 100, 0.1).name('heatImpactStrength')
    heat.addColor(u.emissiveColor, 'value').name('emissiveColor')

    const cursor = gui.addFolder('Cursor')
    cursor.add(u.cursorRadius, 'value', 0, 5, 0.001).name('cursorRadius')
    cursor.add(u.cursorStrength, 'value', 0, 0.2, 0.001).name('cursorStrength')
    cursor.add(u.cursorHeatStrength, 'value', 0, 100, 0.1).name('cursorHeatStrength')

    const lights = gui.addFolder('Lights')
    lights.addColor(hero.directionalLight, 'color').name('directionalColor')
    lights.add(hero.directionalLight, 'intensity', 0, 5, 0.01).name('directionalIntensity')
    lights.add(hero.lightSpherical, 'phi', 0, Math.PI, 0.001).name('directionalPhi').onChange(() => hero.updateLightPosition())
    lights.add(hero.lightSpherical, 'theta', -Math.PI, Math.PI, 0.001).name('directionalTheta').onChange(() => hero.updateLightPosition())
    lights.addColor(hero.ambientLight, 'color').name('ambientColor')
    lights.add(hero.ambientLight, 'intensity', 0, 0.2, 0.0001).name('ambientIntensity')
    // Тени — второй проход по всем инстансам, первое, что стоит выключить при просадке
    lights.add(hero.directionalLight, 'castShadow').name('shadows')

    const post = gui.addFolder('Post')
    post.add(hero.bloomPass.threshold, 'value', 0, 2, 0.01).name('bloomThreshold')
    post.add(hero.bloomPass.strength, 'value', 0, 2, 0.01).name('bloomStrength')
    post.add(hero.renderer, 'toneMappingExposure', 0, 5, 0.01).name('exposure')
}
