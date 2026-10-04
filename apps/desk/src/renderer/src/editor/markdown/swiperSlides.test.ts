// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import {
  parseSwiperSlides,
  serializeSwiperSlides,
  swiperSlideTabTitle,
  updateSwiperSlideAttrs,
  withSwiperSlideTitle,
  wrapSlideIndex
} from './swiperSlides'

describe('swiperSlides', () => {
  it('parses markdown image lines and ignores blanks', () => {
    expect(parseSwiperSlides('![one](./a.png)\n\n![two](https://cdn.example/b.png)\n\n')).toEqual([
      { alt: 'one', src: './a.png', width: '' },
      { alt: 'two', src: 'https://cdn.example/b.png', width: '' }
    ])
  })

  it('keeps width and written alignment, and centers when align is omitted', () => {
    expect(
      parseSwiperSlides('![](./a.webp) {w=640px}\n\n![右](./b.png) {w=50% align=right}\n')
    ).toEqual([
      { alt: '', src: './a.webp', width: '640px' },
      { alt: '右', src: './b.png', width: '50%', align: 'right' }
    ])
  })

  it('uses img as the default tab title when alt is empty', () => {
    expect(swiperSlideTabTitle({ alt: '', src: './x.png', width: '' })).toBe('img')
    expect(swiperSlideTabTitle({ alt: ' 封面 ', src: './x.png', width: '' })).toBe('封面')
  })

  it('renames via alt and round-trips serialize', () => {
    const renamed = withSwiperSlideTitle({ alt: '1', src: './a.png', width: '640px' }, '封面')
    expect(renamed).toEqual({ alt: '封面', src: './a.png', width: '640px' })
    expect(
      serializeSwiperSlides([renamed, { alt: '', src: './b.png', width: '', align: 'left' }])
    ).toBe('![封面](./a.png) {w=640px}\n\n![](./b.png) {align=left}')
  })

  it('updates one slide without rewriting the other lines', () => {
    const fence = [
      '::: swiper',
      '',
      '123',
      '',
      '![a](./a.png) {w=640px}',
      '',
      '![b](./b.png) {align=right}',
      '',
      ':::'
    ].join('\n')
    expect(updateSwiperSlideAttrs(fence, 0, { align: 'left' })).toBe(
      [
        '::: swiper',
        '',
        '123',
        '',
        '![a](./a.png) {w=640px align=left}',
        '',
        '![b](./b.png) {align=right}',
        '',
        ':::'
      ].join('\n')
    )
    expect(updateSwiperSlideAttrs(fence, 0, { align: null, width: '' })).toBe(
      ['::: swiper', '', '123', '', '![a](./a.png)', '', '![b](./b.png) {align=right}', '', ':::'].join(
        '\n'
      )
    )
  })

  it('wraps slide indices for prev/next nav', () => {
    expect(wrapSlideIndex(0, 3, -1)).toBe(2)
    expect(wrapSlideIndex(2, 3, 1)).toBe(0)
    expect(wrapSlideIndex(1, 3, 1)).toBe(2)
  })
})
