import { describe, it, expect, afterEach } from "vitest";
import { openDb, loadVecExtension, type Db } from "../src/core/store.js";

function f32(values: number[]): Buffer {
  return Buffer.from(new Float32Array(values).buffer);
}

describe("sqlite-vec smoke spike (R1 + R2)", () => {
  let db: Db | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("loads the extension and reports a version", () => {
    db = openDb(":memory:");
    loadVecExtension(db);

    const row = db.prepare("SELECT vec_version() AS v").get() as { v: string };
    expect(typeof row.v).toBe("string");
    expect(row.v.length).toBeGreaterThan(0);
  });

  it("creates a vec0 table, inserts vectors, and runs an ordered KNN query", () => {
    db = openDb(":memory:");
    loadVecExtension(db);

    db.exec(
      "CREATE VIRTUAL TABLE items USING vec0(embedding float[3])",
    );

    const insert = db.prepare(
      "INSERT INTO items(rowid, embedding) VALUES (?, ?)",
    );
    insert.run(1n, f32([1, 0, 0]));
    insert.run(2n, f32([0, 1, 0]));
    insert.run(3n, f32([0.9, 0.1, 0]));

    const rows = db
      .prepare(
        "SELECT rowid, distance FROM items " +
          "WHERE embedding MATCH ? ORDER BY distance LIMIT 3",
      )
      .all(f32([1, 0, 0])) as Array<{ rowid: number; distance: number }>;

    expect(rows).toHaveLength(3);
    expect(rows[0]!.rowid).toBe(1);
    expect(rows[1]!.rowid).toBe(3);
    expect(rows[2]!.rowid).toBe(2);

    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.distance).toBeGreaterThanOrEqual(rows[i - 1]!.distance);
    }
  });
});
