import './style.css'

const $canvas = document.querySelector('.js-canvas')
const $unsupported = document.querySelector('.js-unsupported')

// Проверка до импорта Hero: без WebGPU модуль не должен даже загружаться —
// WebGL-бэкенд не упадёт на compute-проходе, он отрисует мусор
if(!navigator.gpu)
{
    $canvas.hidden = true
    $unsupported.hidden = false
}
else
{
    const { default: Hero } = await import('./Hero.js')

    // Частицы здесь работают пикселями портрета, и на 6000 черт лица уже не разобрать.
    // Цена — квадратичный цикл коллизий: 16000 это ~128M проверок пар на кадр,
    // на слабой GPU снижаем через ?count=
    const count = Number(new URLSearchParams(window.location.search).get('count')) || 16000

    const hero = new Hero({ $canvas, count })
    await hero.init()

    if(window.location.hash === '#debug')
    {
        const { attachDebug } = await import('./debug.js')
        attachDebug(hero)
    }

    hero.play()
}
