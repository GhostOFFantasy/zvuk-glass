"""Подготовка текстурных слоёв утверждённого арта Новы без генерации нового изображения."""
from pathlib import Path
import argparse
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage


def polygon(size, points):
    image = Image.new('L', size)
    ImageDraw.Draw(image).polygon(points, fill=255)
    return np.asarray(image, dtype=np.float32) / 255


HEAD = [
    (526, 108), (544, 121), (558, 139), (574, 130), (575, 106), (566, 79),
    (574, 45), (592, 67), (604, 104), (600, 135), (587, 155), (604, 171),
    (615, 195), (619, 211), (643, 208), (629, 225), (614, 232), (614, 250),
    (633, 267), (622, 292), (602, 309), (578, 322), (575, 349), (589, 376),
    (566, 391), (549, 365), (529, 345), (507, 355), (486, 378), (466, 365),
    (478, 339), (477, 315), (453, 303), (445, 281), (435, 258), (419, 250),
    (420, 236), (440, 224), (438, 198), (423, 178), (406, 161), (409, 140),
    (423, 136), (409, 118), (410, 91), (420, 55), (434, 83), (440, 117),
    (451, 135), (456, 114), (470, 103), (490, 98), (509, 102),
]
ARM = [
    (596, 310), (646, 305), (674, 324), (710, 325), (729, 369), (729, 450),
    (720, 542), (718, 638), (740, 710), (751, 812), (705, 826), (660, 777),
    (638, 720), (624, 650), (609, 575), (594, 510), (574, 450), (570, 380),
]
HEAD_CLEAR = [
    (390, 34), (642, 34), (666, 90), (667, 250), (646, 308), (602, 323),
    (578, 326), (575, 349), (589, 376), (566, 391), (549, 365), (529, 345),
    (507, 355), (486, 378), (466, 365), (478, 339), (477, 315), (435, 315),
    (401, 282), (389, 172),
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--map', type=Path)
    args = parser.parse_args()
    source = Image.open(args.source).convert('RGB')
    args.output.mkdir(parents=True, exist_ok=True)
    pixels = np.asarray(source, dtype=np.float32)
    height, width = pixels.shape[:2]
    head_mask = polygon(source.size, HEAD)
    arm_mask = polygon(source.size, ARM)
    masks = {'head': head_mask, 'arm': arm_mask}
    boxes = {'head': (394, 34, 654, 396), 'arm': (560, 290, 760, 840)}
    clear_masks = {'head': polygon(source.size, HEAD_CLEAR) > .5, 'arm': arm_mask > .5}
    base = pixels.copy()
    cores = {
        'head': polygon(source.size, [(470, 161), (581, 155), (607, 226), (589, 288), (566, 319), (566, 358), (544, 352), (529, 336), (507, 353), (484, 359), (478, 318), (451, 282), (444, 222)]),
        'arm': np.maximum(
            polygon(source.size, [(610, 337), (641, 336), (650, 391), (641, 450), (653, 528), (654, 573), (668, 670), (683, 712), (693, 747), (681, 763), (662, 719), (653, 674), (640, 600), (626, 542), (616, 472), (602, 414)]),
            np.maximum.reduce([
                polygon(source.size, [(611, 402), (650, 376), (702, 338), (680, 383), (665, 406)]),
                polygon(source.size, [(648, 394), (711, 401), (675, 425)]),
                polygon(source.size, [(641, 410), (675, 444), (702, 514), (663, 486), (649, 450)]),
            ])),
    }
    for name, rough in masks.items():
        core = cores[name] > .5
        red, green = pixels[:, :, 0], pixels[:, :, 1]
        # Синий фон отличается от кожи, волос, рогов и отделки соотношением каналов.
        colored = (red > 42) & (red > green * .68)
        mask = ((colored | core) & (rough > .5)).astype(np.float32)
        mask = ndimage.binary_closing(mask > .5, iterations=1) & (rough > .5)
        masks[name] = mask.astype(np.float32)
        alpha = np.asarray(Image.fromarray(np.uint8(mask * 255)).filter(ImageFilter.GaussianBlur(.45)), dtype=np.float32) / 255
        cutout = np.dstack((pixels, alpha * 255)).astype(np.uint8)
        Image.fromarray(cutout).crop(boxes[name]).save(args.output / f'{name}.webp', lossless=True, quality=100)
        # Чистая подложка: убираем и саму часть, и её прежнее свечение.
        clear = clear_masks[name]
        removal = ndimage.binary_dilation(mask > .5, iterations=9)
        blue = pixels[:, :, 2]
        background_only = (blue > red * 1.28) & (green > red * 1.18) & (red < 105)
        known = ((~ndimage.binary_dilation(clear, iterations=8)) & background_only).astype(np.float32)
        sigma = 28 if name == 'head' else 20
        denominator = ndimage.gaussian_filter(known, sigma)
        fill = np.empty_like(pixels)
        for channel in range(3):
            numerator = ndimage.gaussian_filter(base[:, :, channel] * known, sigma)
            fill[:, :, channel] = numerator / np.maximum(denominator, 1e-6)
        feather = np.clip(ndimage.distance_transform_edt(removal) / 7, 0, 1)[:, :, None]
        base = base * (1 - feather) + fill * feather
    Image.fromarray(np.uint8(np.clip(base, 0, 255))).save(args.output / 'base.webp', quality=96, method=6)
    # Контрольная композиция должна совпадать с исходным артом в неподвижной позе.
    composite = Image.fromarray(np.uint8(np.clip(base, 0, 255))).convert('RGBA')
    for name in ('arm', 'head'):
        layer = Image.open(args.output / f'{name}.webp')
        composite.alpha_composite(layer, boxes[name][:2])
    if args.map:
        args.map.mkdir(parents=True, exist_ok=True)
        composite.convert('RGB').save(args.map / 'rig-rest.jpg', quality=95)
        moved = Image.open(args.output / 'base.webp').convert('RGBA')
        for name, angle, pivot in [('arm', 48, (621, 364)), ('head', -5, (529, 329))]:
            layer = Image.new('RGBA', source.size)
            layer.alpha_composite(Image.open(args.output / f'{name}.webp'), boxes[name][:2])
            layer = layer.rotate(angle, resample=Image.Resampling.BICUBIC, center=pivot)
            moved.alpha_composite(layer)
        moved.convert('RGB').save(args.map / 'rig-motion.jpg', quality=95)
        for name in ('head', 'arm'):
            cutout = Image.open(args.output / f'{name}.webp')
            checker = Image.new('RGBA', cutout.size, (75, 82, 98, 255))
            checker.alpha_composite(cutout)
            checker.convert('RGB').save(args.map / f'{name}-matte.jpg', quality=95)
        for name, box in [('head', (370, 20, 700, 410)), ('arm', (535, 310, 780, 850))]:
            crop = source.crop(box).resize(((box[2] - box[0]) * 2, (box[3] - box[1]) * 2))
            draw = ImageDraw.Draw(crop)
            for x in range((box[0] // 25 + 1) * 25, box[2], 25):
                px = (x - box[0]) * 2
                draw.line((px, 0, px, crop.height), fill=(240, 150, 70), width=1)
                draw.text((px + 3, 3), str(x), fill=(255, 220, 100))
            for y in range((box[1] // 25 + 1) * 25, box[3], 25):
                py = (y - box[1]) * 2
                draw.line((0, py, crop.width, py), fill=(240, 150, 70), width=1)
                draw.text((3, py + 3), str(y), fill=(255, 220, 100))
            crop.save(args.map / f'{name}-grid.jpg', quality=93)
            Image.open(args.output / f'{name}.webp').save(args.map / f'{name}-cutout.png')


if __name__ == '__main__':
    main()
