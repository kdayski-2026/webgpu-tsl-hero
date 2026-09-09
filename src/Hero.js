import * as THREE from 'three/webgpu'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import {
    EPSILON, Fn, If, Loop, TWO_PI,
    color, deltaTime, dot, float, hash, instancedArray, instanceIndex,
    luminance, pass, positionLocal, uint, uniform, vec3
} from 'three/tsl'
import { loadFaceTargets } from './faceTargets.js'

/**
 * Облако сфер, собирающееся в лицо: каждая частица летит к своей точке на скане головы и
 * несёт цвет из фотографии, спроецированной на эту голову спереди. Позиции, скорости и
 * «нагрев» живут в storage-буферах, вся симуляция — один TSL compute-шейдер на кадр.
 *
 * Только WebGPU: цикл коллизий пишет в элементы буферов, принадлежащие другим частицам.
 * WebGL-бэкенд реализует compute() через transform feedback и такое не поддерживает —
 * он не упадёт, он молча отрендерит мусор. Проверку делает вызывающий код, до импорта.
 */
export default class Hero
{
    constructor(_options)
    {
        this.$canvas = _options.$canvas
        this.count = _options.count

        this.playing = false

        // Разброс по глубине между самым тёмным и самым светлым пикселем. Небо на
        // снимке светлее лица, так что сильный рельеф выпячивает фон вперёд — отсюда
        // сдержанное значение.
        this.depth = 0.9

        this.tick = this.tick.bind(this)
        this.resize = this.resize.bind(this)
    }

    /**
     * Отдельно от конструктора: init() у рендерера асинхронный — до его завершения нельзя
     * ни собрать пайплайн, ни запустить init-compute
     */
    async init()
    {
        this.setSizes()
        await this.setRenderer()
        this.setScene()
        this.setCamera()
        this.setLights()
        this.setCursor()
        await this.setFace()
        this.setParticles()
        this.setPostProcessing()

        this.resize()

        window.addEventListener('resize', this.resize)
    }

    /**
     * Сетка редко делится на запрошенное число нацело — частиц ровно столько, сколько
     * в ней ячеек, иначе хвост буфера остался бы в нуле и слипся в точку
     */
    async setFace()
    {
        this.face = await loadFaceTargets({ count: this.count, photoUrl: '/face.jpg' })
        this.sampled = this.face.build(this.depth, this.sceneHeight())
        this.count = this.sampled.count
    }

    /**
     * Снимок занимает всю видимую высоту, ширина следует за его пропорциями. Величина
     * зависит только от угла и удаления камеры, а они постоянны, поэтому от формы окна
     * раскладка не зависит и на ресайзе не пересобирается.
     */
    sceneHeight()
    {
        return 2 * this.camera.position.z * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)
    }

    /** Плотный массив по три числа на частицу — в буфер с шагом в четыре */
    writeVec3(buffer, source, length = this.count)
    {
        const target = buffer.value.array

        for(let i = 0; i < length; i++)
        {
            target[i * 4 + 0] = source[i * 3 + 0]
            target[i * 4 + 1] = source[i * 3 + 1]
            target[i * 4 + 2] = source[i * 3 + 2]
        }

        buffer.value.needsUpdate = true
    }

    /** Пересбор целей под новую глубину. Цвета не трогаются — они привязаны к пикселю */
    rebuildFace()
    {
        const sampled = this.face.build(this.depth, this.sceneHeight())

        this.writeVec3(this.targetsBuffer, sampled.positions, Math.min(sampled.count, this.count))
    }

    setSizes()
    {
        this.sizes = {}
        this.sizes.width = window.innerWidth
        this.sizes.height = window.innerHeight
        this.sizes.pixelRatio = Math.min(window.devicePixelRatio, 2)
    }

    async setRenderer()
    {
        this.renderer = new THREE.WebGPURenderer({
            canvas: this.$canvas,
            antialias: true
        })

        this.renderer.toneMapping = THREE.CineonToneMapping
        this.renderer.shadowMap.enabled = true
        this.renderer.shadowMap.type = THREE.PCFShadowMap
        this.renderer.setClearColor(0x252028)

        await this.renderer.init()
    }

    setScene()
    {
        this.scene = new THREE.Scene()
    }

    setCamera()
    {
        this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100)
        this.camera.position.z = 16
        this.scene.add(this.camera)
    }

    setLights()
    {
        this.directionalLight = new THREE.DirectionalLight(0xefd6ff, 0.3)
        this.directionalLight.castShadow = true
        this.directionalLight.shadow.camera.near = 1
        this.directionalLight.shadow.camera.far = 22
        this.directionalLight.shadow.camera.top = 9
        this.directionalLight.shadow.camera.right = 9
        this.directionalLight.shadow.camera.bottom = -9
        this.directionalLight.shadow.camera.left = -9
        this.directionalLight.shadow.mapSize.set(1024, 1024)
        this.directionalLight.shadow.radius = 30
        this.directionalLight.shadow.normalBias = -0.1
        this.scene.add(this.directionalLight)

        this.lightSpherical = new THREE.Spherical(8, 1, 1.6)
        this.updateLightPosition()

        this.ambientLight = new THREE.AmbientLight(0xead1ff, 0.07)
        this.scene.add(this.ambientLight)
    }

    updateLightPosition()
    {
        this.lightSpherical.makeSafe()
        this.directionalLight.position.setFromSpherical(this.lightSpherical)
    }

    /**
     * Частицы чувствуют не позицию курсора, а его смещение за кадр: неподвижная мышь
     * ничего не делает, взмах — расталкивает облако.
     */
    setCursor()
    {
        this.cursor = {}
        this.cursor.raycaster = new THREE.Raycaster()
        this.cursor.ndc = new THREE.Vector2()
        // Плоскость смотрит в камеру и проходит через центр сцены, поэтому курсор
        // оказывается в середине облака, а не перед ним. Камера не двигается — считаем один раз.
        this.cursor.plane = new THREE.Plane(this.camera.position.clone().normalize(), 0)
        this.cursor.intersect = new THREE.Vector3()
        // Скорость — дельта между кадрами, и первый замер прочитался бы как прыжок
        // из нуля, разбросав всё облако на старте
        this.cursor.sampled = false

        this.cursor.onPointerMove = (_event) =>
        {
            const bounding = this.$canvas.getBoundingClientRect()

            this.cursor.ndc.x = (_event.clientX - bounding.left) / bounding.width * 2 - 1
            this.cursor.ndc.y = -((_event.clientY - bounding.top) / bounding.height) * 2 + 1
        }

        window.addEventListener('pointermove', this.cursor.onPointerMove)
    }

    /**
     * Один instanced-меш, три буфера, два compute-прохода.
     *
     * initCompute раскидывает сферы по объёму один раз. updateCompute крутится каждый
     * кадр: толчок курсором, гравитация к центру, попарный цикл коллизий с обменом
     * импульсами и накоплением нагрева. Нагрев читает emissiveNode, поэтому сильный удар
     * вспыхивает оранжевым и гаснет за следующие кадры.
     */
    setParticles()
    {
        const count = this.count

        this.positionsBuffer = instancedArray(count, 'vec3')
        this.velocitiesBuffer = instancedArray(count, 'vec3')
        this.heatBuffer = instancedArray(count, 'float')

        // vec4, а не vec3: эти два буфера заполняются с CPU, а у vec3 в WGSL шаг 16 байт
        // против 12 у плотного массива на стороне JS. Четвёртый компонент не используется.
        this.targetsBuffer = instancedArray(count, 'vec4')
        this.colorsBuffer = instancedArray(count, 'vec4')

        this.writeVec3(this.targetsBuffer, this.sampled.positions)
        this.writeVec3(this.colorsBuffer, this.sampled.colors)

        this.uniforms = {
            // Оба радиуса привязаны к шагу сетки целей. Видимый чуть больше половины
            // шага, чтобы сферы перекрыли диагональные просветы и кожа стала сплошной.
            // Контактный - чуть меньше половины: в покое соседи не дотягиваются друг до
            // друга, цикл коллизий простаивает и не сдвигает частицы с их пикселей.
            radius: uniform(this.sampled.spacing * 1.05),
            contactRadius: uniform(this.sampled.spacing * 0.46),
            gravityStrength: uniform(0.025),
            pullRange: uniform(1.5),
            // Сцена освещена слабо, и на одном Lambert фотография уходит в темноту.
            // Выше ~0.3 снимок с жёстким солнцем пересвечивается в белое пятно.
            photoGlow: uniform(0.25),
            impactDamping: uniform(0.05),
            generalDamping: uniform(0.4),
            heatDamping: uniform(3),
            heatImpactStrength: uniform(20),
            emissiveColor: uniform(color(0xff3f0f)),
            cursorPosition: uniform(vec3()),
            cursorVelocity: uniform(vec3()),
            cursorRadius: uniform(1.75),
            cursorStrength: uniform(0.04),
            cursorHeatStrength: uniform(30)
        }

        const u = this.uniforms

        // Равномерная точка внутри шара
        const pointInSphere = Fn(([ seed = uint(0), radius = float(1) ]) =>
        {
            const theta = hash(seed).mul(TWO_PI)
            const phi = hash(seed.add(123).mul(2)).remap(0, 1, -1, 1).acos()
            // Кубический корень: объём шарового слоя растёт как r², и без него
            // выборка сгущается к центру
            const r = radius.mul(hash(seed.add(456).mul(3)).pow(1 / 3))
            const sinPhi = phi.sin()

            return vec3(
                theta.sin().mul(sinPhi),
                phi.cos(),
                theta.cos().mul(sinPhi)
            ).mul(r)
        }, { seed: 'uint', radius: 'float', return: 'vec3' })

        const initCompute = Fn(() =>
        {
            const position = this.positionsBuffer.element(instanceIndex)

            position.assign(pointInSphere(instanceIndex, 4))
            // Сплюснуто по Z: в кадре облако читается как стена частиц, а не как шар
            position.mulAssign(vec3(3, 3, 1))
        })().compute(count)

        this.renderer.compute(initCompute)

        this.updateCompute = Fn(() =>
        {
            // Вкладка из фона возвращается одним огромным кадром, на котором сферы
            // протуннелировали бы сквозь соседей
            const clampedDeltaTime = deltaTime.min(1 / 30)

            const aPosition = this.positionsBuffer.element(instanceIndex)
            const aVelocity = this.velocitiesBuffer.element(instanceIndex)
            const aHeat = this.heatBuffer.element(instanceIndex)

            // Курсор
            const cursorDistance = aPosition.distance(u.cursorPosition)
            const cursorRatio = cursorDistance.div(u.cursorRadius).remap(0.5, 1).oneMinus().max(0)
            const cursorPush = u.cursorVelocity.mul(cursorRatio).mul(u.cursorStrength)
            aVelocity.addAssign(cursorPush)
            aHeat.addAssign(cursorPush.length().mul(u.cursorHeatStrength))

            // Притяжение к своей точке на лице. Сила растёт с расстоянием и упирается в
            // потолок: вдали это тяга к цели, вблизи — пружина, гасящая перелёт
            const toTarget = this.targetsBuffer.element(instanceIndex).xyz.sub(aPosition)
            const targetDistance = toTarget.length()
            aVelocity.addAssign(
                toTarget.div(targetDistance.max(EPSILON))
                    .mul(targetDistance.min(u.pullRange))
                    .mul(u.gravityStrength)
                    .mul(clampedDeltaTime)
            )

            // Коллизии: каждая нить обрабатывает пары (instanceIndex, i > instanceIndex),
            // так каждая пара считается один раз
            Loop({ start: instanceIndex.add(1), end: count, condition: '<', name: 'i' }, ({ i }) =>
            {
                const bPosition = this.positionsBuffer.element(i)
                const bVelocity = this.velocitiesBuffer.element(i)
                const bHeat = this.heatBuffer.element(i)

                const delta = bPosition.sub(aPosition)
                const distance = delta.length()
                const direction = delta.div(distance.max(EPSILON))
                const contact = u.contactRadius.mul(2)

                If(distance.lessThan(contact), () =>
                {
                    // Развести на глубину пересечения, поровну в обе стороны
                    const avoidance = direction.mul(contact.sub(distance).div(2))
                    aPosition.subAssign(avoidance)
                    bPosition.addAssign(avoidance)

                    // Обмен импульсами вдоль нормали столкновения
                    const impact = dot(aVelocity.sub(bVelocity), direction)
                    const impactVelocity = direction.mul(impact).mul(u.impactDamping.oneMinus())
                    aVelocity.subAssign(impactVelocity)
                    bVelocity.addAssign(impactVelocity)

                    // Нагрев по силе удара, порог отсекает вечное свечение от тряски в куче
                    const heat = impact.sub(0.01).max(0).mul(u.heatImpactStrength)
                    aHeat.addAssign(heat)
                    bHeat.addAssign(heat)
                })
            })

            aPosition.addAssign(aVelocity)
            aVelocity.mulAssign(u.generalDamping.mul(clampedDeltaTime).oneMinus())
            aHeat.mulAssign(u.heatDamping.mul(clampedDeltaTime).oneMinus())
        })().compute(count)

        this.geometry = new THREE.IcosahedronGeometry(1, 2)
        this.material = new THREE.MeshLambertNodeMaterial({ color: 0xffffff })

        // Геометрия — единичная сфера в нуле, масштаб и позицию инстанса даёт буфер:
        // один draw call на все частицы
        this.material.positionNode = Fn(() =>
        {
            positionLocal.mulAssign(u.radius)
            positionLocal.addAssign(this.positionsBuffer.element(instanceIndex))

            return positionLocal
        })()

        // Цвет частицы — её пиксель фотографии
        const photoColor = this.colorsBuffer.element(instanceIndex).xyz
        this.material.colorNode = photoColor

        // Фото подсвечено само по себе: сцена освещена слабо, и на одном Lambert лицо
        // ушло бы в темноту. Нагрев от ударов ложится оранжевым поверх, нормированный по
        // яркости, чтобы ползунок задавал силу, а не оттенок.
        this.material.emissiveNode = photoColor.mul(u.photoGlow).add(
            u.emissiveColor
                .div(luminance(u.emissiveColor))
                .mul(this.heatBuffer.element(instanceIndex))
        )

        this.mesh = new THREE.Mesh(this.geometry, this.material)
        this.mesh.castShadow = true
        this.mesh.receiveShadow = true
        // Геометрия лежит в нуле, о разъехавшихся инстансах знает только шейдер —
        // иначе three отсечёт весь меш целиком
        this.mesh.frustumCulled = false
        this.mesh.count = count
        this.scene.add(this.mesh)
    }

    /**
     * Слабый bloom с порогом почти в нуле: белые сферы под Cineon слишком тёмные, чтобы
     * его набрать, так что светятся именно вспышки от ударов
     */
    setPostProcessing()
    {
        this.renderPipeline = new THREE.RenderPipeline(this.renderer)

        const scenePassColor = pass(this.scene, this.camera).getTextureNode('output')

        this.bloomPass = bloom(scenePassColor)
        this.bloomPass.threshold.value = 0.05
        this.bloomPass.strength.value = 0.15

        this.renderPipeline.outputNode = scenePassColor.add(this.bloomPass)
    }

    resize()
    {
        this.sizes.width = window.innerWidth
        this.sizes.height = window.innerHeight
        this.sizes.pixelRatio = Math.min(window.devicePixelRatio, 2)

        this.camera.aspect = this.sizes.width / this.sizes.height
        this.camera.updateProjectionMatrix()

        this.renderer.setPixelRatio(this.sizes.pixelRatio)
        // Размеры канваса задаёт CSS, рендерер не должен писать их инлайном
        this.renderer.setSize(this.sizes.width, this.sizes.height, false)
    }

    tick()
    {
        this.cursor.raycaster.setFromCamera(this.cursor.ndc, this.camera)
        this.cursor.raycaster.ray.intersectPlane(this.cursor.plane, this.cursor.intersect)

        if(this.cursor.sampled)
            this.uniforms.cursorVelocity.value.copy(this.cursor.intersect).sub(this.uniforms.cursorPosition.value)
        else
            this.uniforms.cursorVelocity.value.set(0, 0, 0)

        this.uniforms.cursorPosition.value.copy(this.cursor.intersect)
        this.cursor.sampled = true

        this.renderer.compute(this.updateCompute)
        this.renderPipeline.render()
    }

    play()
    {
        if(this.playing)
            return

        this.playing = true
        // Что делал указатель, пока сцена стояла, — не дельта кадра
        this.cursor.sampled = false
        this.renderer.setAnimationLoop(this.tick)
    }

    pause()
    {
        if(!this.playing)
            return

        this.playing = false
        this.renderer.setAnimationLoop(null)
    }
}
