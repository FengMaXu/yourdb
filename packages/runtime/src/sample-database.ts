import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** The demo store's file name; the same data is rebuilt only when the file is missing. */
export const SAMPLE_DATABASE_FILE = "sample-sales.sqlite";

const REGIONS: Record<string, readonly string[]> = {
  华东: ["上海", "杭州", "南京", "苏州"],
  华南: ["广州", "深圳", "厦门"],
  华北: ["北京", "天津", "济南"],
  西南: ["成都", "重庆", "昆明"],
  华中: ["武汉", "长沙", "郑州"],
};
const SEGMENTS = ["企业", "个人", "政府与教育"] as const;
const CHANNELS = ["线上商城", "门店", "经销商"] as const;
const PRODUCTS: ReadonlyArray<readonly [string, string, number]> = [
  ["轻薄笔记本 14", "电脑", 5999],
  ["性能笔记本 16", "电脑", 8999],
  ["台式主机", "电脑", 4599],
  ["27 英寸显示器", "外设", 1599],
  ["机械键盘", "外设", 499],
  ["无线鼠标", "外设", 149],
  ["降噪耳机", "音频", 1299],
  ["蓝牙音箱", "音频", 399],
  ["平板电脑 11", "移动设备", 3299],
  ["智能手表", "移动设备", 1899],
  ["移动电源", "配件", 199],
  ["Type-C 扩展坞", "配件", 329],
];

/** A small seeded generator, so the same day always produces the same rows. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function pick<T>(next: () => number, items: readonly T[]): T {
  return items[Math.floor(next() * items.length)]!;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function build(file: string, today: Date): void {
  const db = new DatabaseSync(file);
  try {
    db.exec(`
      CREATE TABLE customers (customer_id INTEGER PRIMARY KEY, customer_name TEXT NOT NULL, city TEXT NOT NULL, region TEXT NOT NULL, segment TEXT NOT NULL, signup_date TEXT NOT NULL);
      CREATE TABLE products (product_id INTEGER PRIMARY KEY, product_name TEXT NOT NULL, category TEXT NOT NULL, list_price REAL NOT NULL);
      CREATE TABLE orders (order_id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(customer_id), order_date TEXT NOT NULL, channel TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE order_items (order_id INTEGER NOT NULL REFERENCES orders(order_id), product_id INTEGER NOT NULL REFERENCES products(product_id), quantity INTEGER NOT NULL, unit_price REAL NOT NULL, discount REAL NOT NULL, PRIMARY KEY (order_id, product_id));
    `);
    const next = random(20240101);
    db.exec("BEGIN");
    const product = db.prepare("INSERT INTO products VALUES (?, ?, ?, ?)");
    PRODUCTS.forEach(([name, category, price], index) => product.run(index + 1, name, category, price));

    const customer = db.prepare("INSERT INTO customers VALUES (?, ?, ?, ?, ?, ?)");
    const regions = Object.keys(REGIONS);
    const customerCount = 240;
    for (let id = 1; id <= customerCount; id += 1) {
      const region = pick(next, regions);
      const city = pick(next, REGIONS[region]!);
      const segment = pick(next, SEGMENTS);
      const signup = new Date(Date.UTC(today.getUTCFullYear() - 3, today.getUTCMonth(), 1) + Math.floor(next() * 730) * 86_400_000);
      customer.run(id, `${city}${segment === "个人" ? "客户" : "客户单位"}${String(id).padStart(3, "0")}`, city, region, segment, isoDate(signup));
    }

    const order = db.prepare("INSERT INTO orders VALUES (?, ?, ?, ?, ?)");
    const item = db.prepare("INSERT INTO order_items VALUES (?, ?, ?, ?, ?)");
    let orderId = 1;
    // Two full years up to today, so "last month" and "the past 12 months" have data whenever the sample is made.
    const start = Date.UTC(today.getUTCFullYear() - 2, today.getUTCMonth(), 1);
    const days = Math.floor((Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - start) / 86_400_000) + 1;
    for (let day = 0; day < days; day += 1) {
      const date = new Date(start + day * 86_400_000);
      const month = date.getUTCMonth();
      // Steady growth, with peaks around the June and November shopping festivals.
      const season = month === 10 ? 1.8 : month === 5 ? 1.4 : month === 1 ? 0.7 : 1;
      const expected = (3 + day / 240) * season;
      const count = Math.max(0, Math.round(expected + (next() - 0.5) * 3));
      for (let n = 0; n < count; n += 1) {
        const status = next() < 0.06 ? "已退款" : "已完成";
        order.run(orderId, 1 + Math.floor(next() * customerCount), isoDate(date), pick(next, CHANNELS), status);
        const lines = 1 + Math.floor(next() * 3);
        const chosen = new Set<number>();
        for (let line = 0; line < lines; line += 1) chosen.add(1 + Math.floor(next() * PRODUCTS.length));
        for (const productId of chosen) {
          const listPrice = PRODUCTS[productId - 1]![2];
          const discount = next() < 0.3 ? Math.round(next() * 15) / 100 : 0;
          item.run(orderId, productId, 1 + Math.floor(next() * 4), listPrice, discount);
        }
        orderId += 1;
      }
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

/**
 * Creates the demo sales database under `directory` and returns its path.
 * An existing file is kept, so trying the sample twice does not reset it.
 */
export function ensureSampleDatabase(directory: string, today = new Date()): string {
  const file = path.join(directory, SAMPLE_DATABASE_FILE);
  if (existsSync(file)) return file;
  mkdirSync(directory, { recursive: true });
  // Built beside the target and renamed, so a failed build never leaves a half-filled file in use.
  const partial = `${file}.${process.pid}.partial`;
  rmSync(partial, { force: true });
  try {
    build(partial, today);
    renameSync(partial, file);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
  return file;
}
