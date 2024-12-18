import assert = require("assert");
import { getPaginationFor } from "../../../services/pagination";

describe('Pagination Tests', () => {
  it('should handle the first page', () => {
    const result = getPaginationFor('test', 1, 100, 10);
    assert.strictEqual(result.prevPage, undefined);
    assert.strictEqual(result.nextPage, 2);
    assert.strictEqual(result.endPage, 10);
    assert.strictEqual(result.displayText, 'Showing 1 to 10 of 100 records');
  });

  it('should handle a middle page', () => {
    const result = getPaginationFor('test', 5, 100, 10);
    assert.strictEqual(result.prevPage, 4);
    assert.strictEqual(result.nextPage, 6);
    assert.strictEqual(result.endPage, 10);
    assert.strictEqual(result.displayText, 'Showing 41 to 50 of 100 records');
  });

  it('should handle the last page', () => {
    const result = getPaginationFor('test', 10, 100, 10);
    assert.strictEqual(result.prevPage, 9);
    assert.strictEqual(result.nextPage, undefined);
    assert.strictEqual(result.endPage, 10);
    assert.strictEqual(result.displayText, 'Showing 91 to 100 of 100 records');
  });

  it('should handle zero total items', () => {
    const result = getPaginationFor('test', 1, 0, 10);
    assert.strictEqual(result.prevPage, undefined);
    assert.strictEqual(result.nextPage, undefined);
    assert.strictEqual(result.endPage, 1);
    assert.strictEqual(result.displayText, 'Showing 0 to 0 of 0 records');
  });

  it('should handle a single item', () => {
    const result = getPaginationFor('test', 1, 1, 10);
    assert.strictEqual(result.prevPage, undefined);
    assert.strictEqual(result.nextPage, undefined);
    assert.strictEqual(result.endPage, 1);
    assert.strictEqual(result.displayText, 'Showing 1 to 1 of 1 records');
  });

  it('should handle a single page with less items than per page limit', () => {
    const result = getPaginationFor('test', 1, 8, 10);
    assert.strictEqual(result.prevPage, undefined);
    assert.strictEqual(result.nextPage, undefined);
    assert.strictEqual(result.endPage, 1);
    assert.strictEqual(result.displayText, 'Showing 1 to 8 of 8 records');
  });

  it('should handle the second page when total items are exactly one page plus one', () => {
    const result = getPaginationFor('test', 2, 11, 10);
    assert.strictEqual(result.prevPage, 1);
    assert.strictEqual(result.nextPage, undefined);
    assert.strictEqual(result.endPage, 2);
    assert.strictEqual(result.displayText, 'Showing 11 to 11 of 11 records');
  });

  it('should handle a large number of total items', () => {
    const result = getPaginationFor('test', 50, 1000000, 20);
    assert.strictEqual(result.prevPage, 49);
    assert.strictEqual(result.nextPage, 51);
    assert.strictEqual(result.endPage, 50000);
    assert.strictEqual(result.displayText, 'Showing 981 to 1,000 of 1,000,000 records');
  });
});
