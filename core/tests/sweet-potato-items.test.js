const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 以薯换福（2026-11-25 ~ 2026-12-09）的道具配置与图标来自
// muyuewang/qq-farm-bot-li 的官方 ItemInfo / Plant / Illustrated 解表。
// 背包卡片的名字取 getItemById(...).name，图标取 getItemImageById(...)，
// 后者只认 seed_images_named/seed_images/<id>.png 这种数字文件名，
// 所以名称条目和同名 PNG 必须成对存在，缺一个就会退回「物品40307」+「物」字占位。
const configDir = path.join(__dirname, '../src/gameConfig');
const imageDir = path.join(configDir, 'seed_images_named/seed_images');
const items = JSON.parse(fs.readFileSync(path.join(configDir, 'ItemInfo.json'), 'utf8'));
const plants = JSON.parse(fs.readFileSync(path.join(configDir, 'Plant.json'), 'utf8'));
const illustrated = JSON.parse(fs.readFileSync(path.join(configDir, 'Illustrated.json'), 'utf8'));
const itemById = new Map(items.map(row => [Number(row.id), row]));
const plantById = new Map(plants.map(row => [Number(row.id), row]));

const SWEET_POTATO_ITEMS = [
  [20307, '红薯种子', 5],
  [40307, '红薯', 6],
  [1040307, '黄金·红薯', 17],
  [1032, '蜜薯', 19],
  [1033, '福气币', 19],
];

function assertIcon(itemId) {
  const file = path.join(imageDir, `${itemId}.png`);
  assert.ok(fs.existsSync(file), `缺少 ${itemId}.png 图标`);
  const buffer = fs.readFileSync(file);
  assert.ok(buffer.length > 1024, `${itemId}.png 文件内容异常`);
  assert.equal(buffer.subarray(1, 4).toString(), 'PNG', `${itemId}.png 不是 PNG`);
}

test('以薯换福道具都有中文名、正确类型与专属图标', () => {
  for (const [id, name, type] of SWEET_POTATO_ITEMS) {
    const item = itemById.get(id);
    assert.ok(item, `ItemInfo 缺少 ${id}`);
    assert.equal(item.name, name, `${id} 名称不匹配`);
    assert.equal(Number(item.type), type, `${id} 类型不匹配`);
    assert.equal(item.activity_id, 2026110708, `${id} 应归属以薯换福活动配置`);
    assertIcon(id);
  }
});

test('红薯果实与黄金果实的模型资源指向 Crop_307', () => {
  assert.equal(itemById.get(20307).asset_name, 'Crop_307');
  assert.equal(itemById.get(40307).asset_name, 'Crop_307');
  assert.equal(itemById.get(1040307).asset_name, 'gold/Crop_307');
  assert.equal(itemById.get(40307).sells, '1001:240');
  assert.equal(itemById.get(1040307).sells, '1005:3');
});

test('红薯植株登记了种子/果实映射，土地卡片不再显示未知作物', () => {
  const normal = plantById.get(1020307);
  const golden = plantById.get(1120307);
  assert.ok(normal && golden, 'Plant 缺少红薯植株');
  assert.equal(normal.name, '红薯');
  assert.equal(Number(normal.seed_id), 20307);
  assert.equal(Number(normal.fruit.id), 40307);
  assert.equal(golden.name, '黄金·红薯');
  assert.equal(Number(golden.fruit.id), 1040307);
});

test('红薯图鉴条目已登记（普通果实 / 黄金果实）', () => {
  const rows = illustrated.filter(row => [40307001, 1040307001].includes(Number(row.id)));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => Number(row.param)).sort((a, b) => a - b), [40307, 1040307]);
});
