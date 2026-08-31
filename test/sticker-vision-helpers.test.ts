import assert from 'node:assert/strict'
import test from 'node:test'
import { SEMANTIC_STICKER_LIMIT, rankStickerCatalog, shouldDownscaleImage, stableStickerAssetId } from '../src/service'

function asset(id: number, embedding?: number[]) {
  return { id, embedding }
}

test('rankStickerCatalog passes through when below the limit or without a query vector', () => {
  const assets = [asset(1), asset(2), asset(3)]
  assert.deepEqual(rankStickerCatalog(assets, [1, 0], 12), assets)
  assert.deepEqual(rankStickerCatalog(assets, [], 2), assets)
})

test('rankStickerCatalog orders by cosine similarity and fills leftover slots with unvectorized assets', () => {
  const assets = [
    asset(1, [0, 1]),
    asset(2, [1, 0]),
    asset(3),
    asset(4, [0.9, 0.1]),
  ]
  const ranked = rankStickerCatalog(assets, [1, 0], 3)
  assert.deepEqual(ranked.map(item => item.id), [2, 4, 1])
})

test('semantic sticker limit is twelve', () => {
  assert.equal(SEMANTIC_STICKER_LIMIT, 12)
})

test('shouldDownscaleImage gates mime types and small payloads', () => {
  const bigBase64 = 'A'.repeat(220_000)
  const smallBase64 = 'A'.repeat(1_000)
  assert.equal(shouldDownscaleImage('image/jpeg', `data:image/jpeg;base64,${bigBase64}`), true)
  assert.equal(shouldDownscaleImage('image/png', `data:image/png;base64,${bigBase64}`), true)
  assert.equal(shouldDownscaleImage('image/webp', `data:image/webp;base64,${bigBase64}`), true)
  assert.equal(shouldDownscaleImage('image/gif', `data:image/gif;base64,${bigBase64}`), false)
  assert.equal(shouldDownscaleImage('image/svg+xml', `data:image/svg+xml;base64,${bigBase64}`), false)
  assert.equal(shouldDownscaleImage('image/jpeg', `data:image/jpeg;base64,${smallBase64}`), false)
  assert.equal(shouldDownscaleImage('image/jpeg', 'data:image/jpeg;base64,'), false)
})

test('stableStickerAssetId keeps punctuation-colliding filenames globally distinct', () => {
  const hashA = 'a'.repeat(64)
  const hashB = 'b'.repeat(64)
  assert.equal(stableStickerAssetId('bq (6).png', hashA), stableStickerAssetId('bq (6).png', hashA))
  assert.notEqual(stableStickerAssetId('bq (6).png', hashA), stableStickerAssetId('bq [6].png', hashB))
  assert.match(stableStickerAssetId('bq (6).png', hashA), /aaaaaaaaaaaaaaaa$/)
})
