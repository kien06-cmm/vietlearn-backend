'use strict';

/**
 * tests/review-export.test.js — GĐ3.6.8 (file ôn tập PDF/Word cho câu "Sắp xếp")
 *
 * review-export.js là module ES chạy trên TRÌNH DUYỆT (dùng `export`, nằm trong
 * vietlearn-frontend không có package.json "type":"module"), nên Node không
 * require() thẳng được. File này đọc mã nguồn, bỏ từ khoá `export`, rồi chạy trong
 * một `vm` context riêng — chỉ để lấy hàm THUẦN buildReviewBodyHtml() (không đụng
 * document/Blob/window, những thứ đó chỉ nằm trong downloadReviewAsWord() và
 * printReviewAsPdf() — hai hàm này KHÔNG được gọi ở đây).
 *
 * Chạy:  npm test   (hoặc: node --test tests/review-export.test.js)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE_PATH = path.join(__dirname, '..', '..', 'vietlearn-frontend', 'pages', 'hocsinh', 'review-export.js');

function loadReviewExport() {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8').replace(/^export\s+/gm, '');
    const sandbox = {};
    vm.createContext(sandbox);
    return vm.runInContext(`${source}\n;({ buildReviewBodyHtml })`, sandbox);
}

const { buildReviewBodyHtml } = loadReviewExport();

function material(questions) {
    return { title: 'Bài kiểm tra Lịch sử', subject: 'Lịch sử', includeExplanation: false, questions };
}

function orderingQuestion(overrides) {
    return {
        id: 'q1',
        type: 'ordering',
        text: 'Sắp xếp các sự kiện theo thứ tự thời gian',
        options: [],
        correctIndexes: [],
        essayAnswer: '',
        explanation: '',
        image: '',
        score: 2,
        orderedItems: [
            { id: 'a', text: 'Sự kiện đầu tiên' },
            { id: 'b', text: 'Sự kiện ở giữa' },
            { id: 'c', text: 'Sự kiện cuối cùng' }
        ],
        ...overrides
    };
}

test('review-export — câu "Sắp xếp" có đề + đáp án trong file ôn tập', async (t) => {
    await t.test('in đủ các mục theo ĐÚNG thứ tự đáp án, kèm tiêu đề "Thứ tự đúng"', () => {
        const html = buildReviewBodyHtml(material([orderingQuestion()]));
        assert.ok(html.includes('Thứ tự đúng'));

        const positions = ['Sự kiện đầu tiên', 'Sự kiện ở giữa', 'Sự kiện cuối cùng'].map((s) => html.indexOf(s));
        assert.ok(positions.every((p) => p >= 0), 'thiếu mục nào đó trong file');
        assert.ok(positions[0] < positions[1] && positions[1] < positions[2], 'sai thứ tự đáp án');
    });

    await t.test('đánh số 1., 2., 3. cho từng mục', () => {
        const html = buildReviewBodyHtml(material([orderingQuestion()]));
        assert.ok(html.includes('<span class="opt-label">1.</span>Sự kiện đầu tiên'));
        assert.ok(html.includes('<span class="opt-label">3.</span>Sự kiện cuối cùng'));
    });

    await t.test('bảng đáp án nhanh hiện "Sắp xếp" thay vì "—"', () => {
        const html = buildReviewBodyHtml(material([orderingQuestion()]));
        assert.ok(html.includes('<strong>Câu 1</strong>: Sắp xếp'));
        assert.equal(html.includes('<strong>Câu 1</strong>: —'), false);
    });

    await t.test('escape HTML trong nội dung từng mục (không chèn được thẻ)', () => {
        const html = buildReviewBodyHtml(material([orderingQuestion({
            orderedItems: [{ id: 'a', text: '<img src=x onerror=alert(1)>' }, { id: 'b', text: 'B' }]
        })]));
        assert.equal(html.includes('<img src=x'), false);
        assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    });

    await t.test('server không gửi orderedItems / gửi rỗng: báo rõ, không in "undefined", không crash', () => {
        [undefined, [], null].forEach((orderedItems) => {
            const html = buildReviewBodyHtml(material([orderingQuestion({ orderedItems })]));
            assert.ok(html.includes('Chưa có dữ liệu thứ tự'));
            assert.equal(html.includes('undefined'), false);
        });
    });

    await t.test('mục thiếu text -> in rỗng, không in "undefined"', () => {
        const html = buildReviewBodyHtml(material([orderingQuestion({
            orderedItems: [{ id: 'a' }, { id: 'b', text: 'Có chữ' }]
        })]));
        assert.equal(html.includes('undefined'), false);
        assert.ok(html.includes('Có chữ'));
    });
});

test('review-export — bài trộn trắc nghiệm + Sắp xếp, không ảnh hưởng câu khác', async (t) => {
    const mc = {
        id: 'm1', type: 'multiple_choice', text: 'Câu trắc nghiệm', options: ['Đáp án 1', 'Đáp án 2'],
        correctIndexes: [1], essayAnswer: '', explanation: '', image: '', score: 1
    };
    const html = buildReviewBodyHtml(material([mc, orderingQuestion({ id: 'q2' })]));

    await t.test('câu trắc nghiệm vẫn có đáp án đúng như cũ', () => {
        assert.ok(html.includes('Đáp án đúng: B'));
        assert.ok(html.includes('(Đáp án đúng)'));
    });

    await t.test('bảng đáp án nhanh: Câu 1 -> B, Câu 2 -> Sắp xếp', () => {
        assert.ok(html.includes('<strong>Câu 1</strong>: B'));
        assert.ok(html.includes('<strong>Câu 2</strong>: Sắp xếp'));
    });

    await t.test('câu trắc nghiệm KHÔNG bị chèn khối "Thứ tự đúng"', () => {
        const onlyMc = buildReviewBodyHtml(material([mc]));
        assert.equal(onlyMc.includes('Thứ tự đúng'), false);
    });
});
