/**
 * Готовит две таблицы на частицу: куда лететь и какого быть цвета - прямо из фотографии.
 *
 * Раньше форму давал скан головы, а фото натягивалось на него проекцией. От модели
 * пришлось отказаться: скан снят анфас с нейтральной перспективой, а фотография - снизу
 * и широким углом, пропорции не совпадают в принципе, и черты уезжали мимо геометрии.
 * Здесь форму задаёт сам снимок, поэтому рассогласованию взяться неоткуда.
 *
 * Плоским он при этом не выглядит: глубина берётся из яркости пикселя, освещённое
 * выступает вперёд, тени уходят назад - получается барельеф.
 */
export async function loadFaceTargets({ count, photoUrl })
{
    const photo = await loadPhotoPixels(photoUrl)

    return {
        count,
        photo,
        /**
         * Форма и цвет считаются вместе: обе берутся из одного пикселя, и менять одно
         * без другого смысла нет
         */
        build(depth, height)
        {
            return buildFromPhoto({ count, photo, depth, height })
        }
    }
}

/**
 * Фото декодируется один раз в ImageData уменьшенной ширины: попиксельная точность
 * не нужна, частиц на порядки меньше, чем пикселей оригинала
 */
async function loadPhotoPixels(url, width = 512)
{
    const image = new Image()
    image.src = url
    await image.decode()

    const height = Math.round(width * image.naturalHeight / image.naturalWidth)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height

    const context = canvas.getContext('2d', { willReadFrequently: true })
    context.drawImage(image, 0, 0, width, height)

    return context.getImageData(0, 0, width, height)
}

/**
 * Цели раскладываются по сетке, а не выбираются случайно.
 *
 * Случайные точки сбиваются в кучки и оставляют прогалины: там, где две цели оказались
 * ближе контактного радиуса, коллизии растаскивают частицы с их пикселей, и снимок
 * плывёт. На сетке соседи стоят ровно на шаг друг от друга, разбирать нечего - в покое
 * каждая частица держит свой пиксель, и картинка остаётся резкой.
 */
function buildFromPhoto({ count, photo, depth, height })
{
    // Кадр целиком, без кадрирования: в сцену он кладётся по высоте, ширина следует
    // за пропорциями снимка
    const aspect = photo.width / photo.height
    const worldHeight = height
    const worldWidth = height * aspect

    const columns = Math.max(1, Math.round(Math.sqrt(count * aspect)))
    const rows = Math.max(1, Math.floor(count / columns))

    const accepted = columns * rows
    const positions = new Float32Array(accepted * 3)
    const colors = new Float32Array(accepted * 3)

    let index = 0

    for(let row = 0; row < rows; row++)
    {
        for(let column = 0; column < columns; column++)
        {
            // Лёгкое дрожание внутри ячейки: строгая сетка ловит муар на мелкой текстуре,
            // а сдвиг в осьмую шага его снимает, не сбивая расстояния между соседями
            const cellX = (column + 0.5 + (Math.random() - 0.5) * 0.25) / columns
            const cellY = (row + 0.5 + (Math.random() - 0.5) * 0.25) / rows

            const px = Math.min(photo.width - 1, Math.floor(cellX * photo.width))
            const py = Math.min(photo.height - 1, Math.floor(cellY * photo.height))
            const source = (py * photo.width + px) * 4

            const r = photo.data[source + 0] / 255
            const g = photo.data[source + 1] / 255
            const b = photo.data[source + 2] / 255

            positions[index * 3 + 0] = (cellX - 0.5) * worldWidth
            // Пиксели растут вниз, мир - вверх
            positions[index * 3 + 1] = (0.5 - cellY) * worldHeight
            // Яркость решает, насколько пиксель выступает вперёд
            positions[index * 3 + 2] = (0.2126 * r + 0.7152 * g + 0.0722 * b - 0.5) * depth

            colors[index * 3 + 0] = srgbToLinear(r)
            colors[index * 3 + 1] = srgbToLinear(g)
            colors[index * 3 + 2] = srgbToLinear(b)
            index++
        }
    }

    return { count: accepted, positions, colors, spacing: worldWidth / columns }
}

function srgbToLinear(value)
{
    return value < 0.04045 ? value * 0.0773993808 : Math.pow(value * 0.9478672986 + 0.0521327014, 2.4)
}
