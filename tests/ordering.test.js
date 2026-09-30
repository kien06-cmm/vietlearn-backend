'use strict';

/**
 * tests/ordering.test.js — GĐ3.6.8 (test toàn bộ flow câu "Sắp xếp")
 *
 * Test hồi quy cho 2 lỗi tìm thấy khi test flow Sắp xếp:
 *   1. sanitizeQuestionForClient() không xoá "correctOrder" -> lộ đáp án.
 *   2. buildOrderingView() có thể xáo ra ĐÚNG thứ tự đáp án (2 mục ≈ 50%),
 *      mà lam_bai.js tự lưu thứ tự đang hiển thị làm đáp án mặc định ->
 *      học sinh không đụng vào câu đó vẫn được trọn điểm.
 *
 * Chạy:  npm test   (hoặc: node --test tests)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    sanitizeQuestionForClient,
    buildOrderingView,
    gradeOrdering,
    gradeSubmission,
    toReviewQuestionServer,
    buildOrderingResultView
} = require('../lib/grading');

function makeItems(n) {
    return Array.from({ length: n }, (_, i) => ({ id: `item_${i}`, text: `Mục ${i + 1}` }));
}

test('sanitizeQuestionForClient — câu Sắp xếp không lộ đáp án', async (t) => {
    const q = {
        id: 'q1',
        type: 'ordering',
        question_text: 'Sắp xếp các bước',
        items: [{ id: 'b', text: 'B' }, { id: 'a', text: 'A' }, { id: 'c', text: 'C' }],
        correctOrder: ['a', 'b', 'c'],
        correct_option: null,
        options: []
    };

    await t.test('KHÔNG gửi "correctOrder" xuống client', () => {
        const clean = sanitizeQuestionForClient(q, 'exam1_stu1_q1');
        assert.equal('correctOrder' in clean, false);
        assert.equal(JSON.stringify(clean).includes('"correctOrder"'), false);
    });

    await t.test('"items" gửi xuống chỉ còn {id,text}, đủ mục, không mất/thừa mục nào', () => {
        const clean = sanitizeQuestionForClient(q, 'exam1_stu1_q1');
        assert.equal(clean.items.length, 3);
        assert.deepEqual(clean.items.map((i) => i.id).sort(), ['a', 'b', 'c']);
        clean.items.forEach((it) => assert.deepEqual(Object.keys(it).sort(), ['id', 'text']));
    });

    await t.test('"items" gửi xuống KHÔNG trùng thứ tự đáp án (correctOrder)', () => {
        const clean = sanitizeQuestionForClient(q, 'exam1_stu1_q1');
        assert.notDeepEqual(clean.items.map((i) => i.id), ['a', 'b', 'c']);
    });

    await t.test('không có seed (gọi kiểu cũ) -> ẩn hẳn items và vẫn không lộ correctOrder', () => {
        const clean = sanitizeQuestionForClient(q);
        assert.deepEqual(clean.items, []);
        assert.equal('correctOrder' in clean, false);
    });

    await t.test('không làm biến dạng object gốc (immutable input)', () => {
        const snapshot = JSON.parse(JSON.stringify(q));
        sanitizeQuestionForClient(q, 'exam1_stu1_q1');
        assert.deepEqual(q, snapshot);
    });

    await t.test('correctOrder cũng bị xoá nếu lỡ nằm trên loại câu hỏi khác', () => {
        const clean = sanitizeQuestionForClient({ id: 'q2', type: 'multiple_choice', correctOrder: ['x'], correct_option: 0 });
        assert.equal('correctOrder' in clean, false);
    });
});

test('buildOrderingView — không bao giờ trùng thứ tự đáp án', async (t) => {
    await t.test('dữ liệu hiện tại (items nằm ĐÚNG thứ tự đáp án, chưa có correctOrder): 2..6 mục x 3000 seed', () => {
        for (let n = 2; n <= 6; n++) {
            const items = makeItems(n);
            const correctIds = items.map((i) => i.id);
            for (let s = 0; s < 3000; s++) {
                const view = buildOrderingView(items, `exam_stu${s}_q1`).map((i) => i.id);
                assert.notDeepEqual(view, correctIds, `n=${n}, seed=${s} xáo ra đúng thứ tự đáp án`);
            }
        }
    });

    await t.test('có correctOrder khác thứ tự lưu trong items: view không trùng correctOrder', () => {
        const items = [{ id: 'b', text: 'B' }, { id: 'a', text: 'A' }, { id: 'c', text: 'C' }];
        const correctOrder = ['a', 'b', 'c'];
        for (let s = 0; s < 3000; s++) {
            const view = buildOrderingView(items, `exam_stu${s}_q1`, correctOrder).map((i) => i.id);
            assert.notDeepEqual(view, correctOrder, `seed=${s} xáo ra đúng correctOrder`);
        }
    });

    await t.test('xác định: cùng seed luôn ra cùng thứ tự (F5 không đổi đề)', () => {
        const items = makeItems(5);
        const a = buildOrderingView(items, 'exam_stu_q1').map((i) => i.id);
        const b = buildOrderingView(items, 'exam_stu_q1').map((i) => i.id);
        assert.deepEqual(a, b);
    });

    await t.test('luôn là hoán vị của đúng tập id gốc (không mất/nhân đôi mục)', () => {
        const items = makeItems(4);
        for (let s = 0; s < 500; s++) {
            const ids = buildOrderingView(items, `seed${s}`).map((i) => i.id).sort();
            assert.deepEqual(ids, items.map((i) => i.id).sort());
        }
    });

    await t.test('1 mục hoặc rỗng: không crash, không xoay vô nghĩa', () => {
        assert.deepEqual(buildOrderingView([], 's'), []);
        assert.deepEqual(buildOrderingView(makeItems(1), 's').map((i) => i.id), ['item_0']);
        assert.deepEqual(buildOrderingView(undefined, 's'), []);
    });
});

test('Luồng "học sinh không đụng vào câu Sắp xếp" (lam_bai.js tự lưu thứ tự đang hiển thị)', async (t) => {
    await t.test('nộp nguyên thứ tự được gửi xuống -> KHÔNG được trọn điểm (2..6 mục x 2000 seed)', () => {
        for (let n = 2; n <= 6; n++) {
            const items = makeItems(n);
            const q = { id: 'q1', type: 'ordering', score: 2, items };
            for (let s = 0; s < 2000; s++) {
                const sent = sanitizeQuestionForClient(q, `exam_stu${s}_q1`);
                const untouched = sent.items.map((i) => i.id);
                const result = gradeSubmission([q], { q1: untouched });
                assert.equal(result.details[0].isCorrect, false, `n=${n}, seed=${s} được trọn điểm dù không sắp xếp`);
            }
        }
    });

    await t.test('học sinh sắp ĐÚNG thứ tự đáp án -> vẫn được trọn điểm (không phá chấm điểm)', () => {
        const items = makeItems(4);
        const q = { id: 'q1', type: 'ordering', score: 2, items };
        const result = gradeSubmission([q], { q1: items.map((i) => i.id) });
        assert.equal(result.details[0].isCorrect, true);
        assert.equal(result.earnedPoints, 2);
    });

    await t.test('có correctOrder: sắp đúng correctOrder -> trọn điểm; sắp theo thứ tự lưu trong items -> không', () => {
        const q = {
            id: 'q1', type: 'ordering', score: 3,
            items: [{ id: 'b', text: 'B' }, { id: 'a', text: 'A' }, { id: 'c', text: 'C' }],
            correctOrder: ['a', 'b', 'c']
        };
        assert.equal(gradeOrdering(q, ['a', 'b', 'c']).fraction, 1);
        assert.notEqual(gradeOrdering(q, ['b', 'a', 'c']).fraction, 1);
    });
});

// ---------------------------------------------------------------------------
// GĐ3.6.8 (bổ sung) — "Bỏ qua" khác "Sai", không lộ blanks[].acceptedAnswers, file ôn tập
// ---------------------------------------------------------------------------

test('Câu Sắp xếp: "Bỏ qua" khác "Sai" (chưa thao tác thì chưa có studentAnswer)', async (t) => {
    const items = makeItems(4);
    const ids = items.map((i) => i.id);
    const q = { id: 'q1', type: 'ordering', score: 1, items };

    await t.test('gradeOrdering: không gửi / null / [] / kiểu lạ -> skipped:true, studentAnswer = null, 0 điểm', () => {
        for (const raw of [undefined, null, [], 'abc', {}]) {
            const r = gradeOrdering(q, raw);
            assert.equal(r.skipped, true, `raw=${JSON.stringify(raw)}`);
            assert.equal(r.studentAnswerNormalized, null);
            assert.equal(r.fraction, 0);
        }
    });

    await t.test('gradeOrdering: sắp SAI -> skipped:false và giữ nguyên thứ tự học sinh đã sắp', () => {
        const wrong = [...ids].reverse();
        const r = gradeOrdering(q, wrong);
        assert.equal(r.skipped, false);
        assert.deepEqual(r.studentAnswerNormalized, wrong);
        assert.ok(r.fraction < 1);
    });

    await t.test('gradeSubmission: 3 câu Sắp xếp -> 1 Đúng / 1 Bỏ qua / 1 Sai, tách bạch', () => {
        const qs = ['qa', 'qb', 'qc'].map((id) => ({ id, type: 'ordering', score: 1, items: makeItems(3) }));
        const result = gradeSubmission(qs, {
            qa: ['item_0', 'item_1', 'item_2'],   // đúng
            qc: ['item_2', 'item_1', 'item_0']    // sai (đúng 1/3 vị trí nhưng KHÔNG phải bỏ qua)
            // qb: học sinh không thao tác -> không có câu trả lời
        });

        assert.equal(result.correctCount, 1);
        assert.equal(result.skippedCount, 1);
        assert.equal(result.incorrectCount, 1);

        const byId = Object.fromEntries(result.details.map((d) => [d.questionId, d]));
        assert.equal(byId.qa.skipped, false);
        assert.equal(byId.qa.isCorrect, true);
        assert.equal(byId.qb.skipped, true);
        assert.equal(byId.qb.studentAnswer, null);
        assert.equal(byId.qc.skipped, false);
        assert.equal(byId.qc.isCorrect, false);
        assert.notEqual(byId.qc.studentAnswer, null);
    });

    await t.test('gradeSubmission: bài trộn trắc nghiệm + Sắp xếp, học sinh không làm gì -> tất cả là Bỏ qua, không câu nào là Sai', () => {
        const mc = { id: 'm1', type: 'multiple_choice', options: ['A', 'B'], correct_option: 0, score: 1 };
        const result = gradeSubmission([mc, q], {});
        assert.equal(result.skippedCount, 2);
        assert.equal(result.incorrectCount, 0);
        assert.equal(result.correctCount, 0);
    });
});

test('Câu Điền vào chỗ trống: "Bỏ qua" khác "Sai"', async (t) => {
    const q = { id: 'f1', type: 'fill_blank', score: 1, blanks: [{ acceptedAnswers: ['Hà Nội'] }, { acceptedAnswers: ['Việt Nam'] }] };

    await t.test('mọi ô trống rỗng -> skipped:true', () => {
        const result = gradeSubmission([q], { f1: ['', '  '] });
        assert.equal(result.details[0].skipped, true);
        assert.equal(result.skippedCount, 1);
        assert.equal(result.incorrectCount, 0);
    });

    await t.test('có điền nhưng sai -> KHÔNG phải bỏ qua', () => {
        const result = gradeSubmission([q], { f1: ['Huế', ''] });
        assert.equal(result.details[0].skipped, false);
        assert.equal(result.skippedCount, 0);
        assert.equal(result.incorrectCount, 1);
    });
});

test('sanitizeQuestionForClient — câu Điền vào chỗ trống không lộ acceptedAnswers', async (t) => {
    const q = {
        id: 'f1',
        type: 'fill_blank',
        question_text: 'Thủ đô của ___ là ___',
        blanks: [{ acceptedAnswers: ['Việt Nam', 'Viet Nam'] }, { acceptedAnswers: ['Hà Nội', 'Ha Noi'] }]
    };

    await t.test('mỗi chỗ trống chỉ còn { index }', () => {
        const clean = sanitizeQuestionForClient(q, 'exam1_stu1_f1');
        assert.deepEqual(clean.blanks, [{ index: 0 }, { index: 1 }]);
    });

    await t.test('toàn bộ JSON gửi xuống không chứa đáp án chấp nhận được', () => {
        const json = JSON.stringify(sanitizeQuestionForClient(q, 'exam1_stu1_f1'));
        ['acceptedAnswers', 'Việt Nam', 'Viet Nam', 'Hà Nội', 'Ha Noi'].forEach((secret) => {
            assert.equal(json.includes(secret), false, `lộ "${secret}"`);
        });
    });

    await t.test('gọi kiểu cũ (không seed) vẫn không lộ', () => {
        const json = JSON.stringify(sanitizeQuestionForClient(q));
        assert.equal(json.includes('acceptedAnswers'), false);
        assert.equal(json.includes('Hà Nội'), false);
    });

    await t.test('không làm biến dạng object gốc', () => {
        const snapshot = JSON.parse(JSON.stringify(q));
        sanitizeQuestionForClient(q, 'exam1_stu1_f1');
        assert.deepEqual(q, snapshot);
    });
});

test('toReviewQuestionServer — câu Sắp xếp trong file ôn tập PDF/Word', async (t) => {
    const base = {
        id: 'q1',
        type: 'ordering',
        question_text: 'Sắp xếp các bước',
        items: [{ id: 'b', text: 'Bước B' }, { id: 'a', text: 'Bước A' }, { id: 'c', text: 'Bước C' }],
        score: 2
    };

    await t.test('có correctOrder: orderedItems theo ĐÚNG correctOrder, không phải thứ tự lưu trong items', () => {
        const review = toReviewQuestionServer({ ...base, correctOrder: ['a', 'b', 'c'] }, false);
        assert.deepEqual(review.orderedItems, [
            { id: 'a', text: 'Bước A' },
            { id: 'b', text: 'Bước B' },
            { id: 'c', text: 'Bước C' }
        ]);
    });

    await t.test('chưa có correctOrder (dữ liệu cũ): dự phòng bằng thứ tự mảng items', () => {
        const review = toReviewQuestionServer(base, false);
        assert.deepEqual(review.orderedItems.map((i) => i.id), ['b', 'a', 'c']);
    });

    await t.test('không có options/đáp án chỉ số như trắc nghiệm, vẫn giữ type + điểm', () => {
        const review = toReviewQuestionServer({ ...base, correctOrder: ['a', 'b', 'c'] }, false);
        assert.equal(review.type, 'ordering');
        assert.deepEqual(review.options, []);
        assert.deepEqual(review.correctIndexes, []);
        assert.equal(review.score, 2);
        assert.equal(review.text, 'Sắp xếp các bước');
    });

    await t.test('mục thiếu text -> chuỗi rỗng, id trong correctOrder không có trong items -> không crash', () => {
        const review = toReviewQuestionServer(
            { ...base, items: [{ id: 'a' }, { id: 'b', text: 'Bước B' }], correctOrder: ['a', 'b', 'zzz'] },
            false
        );
        assert.deepEqual(review.orderedItems.map((i) => i.text), ['', 'Bước B', '']);
    });

    await t.test('loại câu hỏi khác KHÔNG có field orderedItems', () => {
        const mc = toReviewQuestionServer({ id: 'm1', type: 'multiple_choice', question_text: 'Q', options: ['A', 'B'], correct_option: 1 }, false);
        assert.equal('orderedItems' in mc, false);
        assert.deepEqual(mc.correctIndexes, [1]);
    });
});

// ---------------------------------------------------------------------------
// GĐ3.6.9 — chấm chặt (hoán vị hợp lệ) + điểm từng phần + dữ liệu "Xem lại"
// ---------------------------------------------------------------------------

test('gradeOrdering — câu trả lời phải là hoán vị hợp lệ', async (t) => {
    const items = makeItems(4);
    const ids = items.map((i) => i.id);
    const q = { id: 'q1', type: 'ordering', score: 1, items };

    await t.test('id trùng lặp -> 0 điểm, KHÔNG phải bỏ qua, giữ nguyên mảng đã nộp', () => {
        const dup = ['item_0', 'item_0', 'item_0', 'item_0'];
        const r = gradeOrdering(q, dup);
        assert.equal(r.fraction, 0);
        assert.equal(r.skipped, false);
        assert.deepEqual(r.studentAnswerNormalized, dup);
        assert.deepEqual(r.correctAnswerForDetail, ids);
    });

    await t.test('thiếu mục / thừa mục / id lạ -> 0 điểm', () => {
        for (const bad of [ids.slice(0, 3), [...ids, 'item_9'], ['item_0', 'item_1', 'item_2', 'zzz']]) {
            const r = gradeOrdering(q, bad);
            assert.equal(r.fraction, 0, JSON.stringify(bad));
            assert.equal(r.skipped, false);
        }
    });

    await t.test('mảng đúng thứ tự vẫn được trọn điểm', () => {
        assert.equal(gradeOrdering(q, ids).fraction, 1);
    });

    await t.test('gradeSubmission: nộp trùng id không kiếm được điểm từng phần và được tính là Sai', () => {
        const result = gradeSubmission([q], { q1: ['item_0', 'item_0', 'item_0', 'item_0'] });
        assert.equal(result.details[0].earnedPoints, 0);
        assert.equal(result.details[0].skipped, false);
        assert.equal(result.incorrectCount, 1);
        assert.equal(result.skippedCount, 0);
    });
});

test('gradeOrdering — điểm từng phần theo số vị trí đúng', async (t) => {
    const items = makeItems(4);
    const q = { id: 'q1', type: 'ordering', score: 2, items };

    await t.test('đúng 2/4 vị trí -> 50%, điểm = 1', () => {
        // đáp án: 0,1,2,3 — học sinh: 0,1,3,2 (đúng vị trí 0 và 1)
        const r = gradeOrdering(q, ['item_0', 'item_1', 'item_3', 'item_2']);
        assert.equal(r.fraction, 0.5);
        const result = gradeSubmission([q], { q1: ['item_0', 'item_1', 'item_3', 'item_2'] });
        assert.equal(result.details[0].earnedPoints, 1);
        assert.equal(result.details[0].isCorrect, false);
    });

    await t.test('đảo ngược hoàn toàn 4 mục -> 0/4 vị trí đúng', () => {
        assert.equal(gradeOrdering(q, ['item_3', 'item_2', 'item_1', 'item_0']).fraction, 0);
    });
});

test('buildOrderingResultView — dữ liệu "Xem lại" cho ketqua.js', async (t) => {
    const q = {
        id: 'q1', type: 'ordering',
        items: [{ id: 'b', text: 'Bước B' }, { id: 'a', text: 'Bước A' }, { id: 'c', text: 'Bước C' }],
        correctOrder: ['a', 'b', 'c']
    };

    await t.test('items = text theo ĐÚNG thứ tự chuẩn (theo correctAnswer), không theo thứ tự mảng items', () => {
        const view = buildOrderingResultView(q, { correctAnswer: ['a', 'b', 'c'], studentAnswer: ['a', 'b', 'c'] });
        assert.deepEqual(view.items, ['Bước A', 'Bước B', 'Bước C']);
    });

    await t.test('studentPositions = vị trí chuẩn của từng id học sinh đã xếp', () => {
        const view = buildOrderingResultView(q, { correctAnswer: ['a', 'b', 'c'], studentAnswer: ['c', 'a', 'b'] });
        assert.deepEqual(view.studentPositions, [2, 0, 1]);
    });

    await t.test('học sinh xếp đúng -> studentPositions = [0,1,2]', () => {
        const view = buildOrderingResultView(q, { correctAnswer: ['a', 'b', 'c'], studentAnswer: ['a', 'b', 'c'] });
        assert.deepEqual(view.studentPositions, [0, 1, 2]);
    });

    await t.test('học sinh bỏ qua (studentAnswer null) -> studentPositions rỗng', () => {
        const view = buildOrderingResultView(q, { correctAnswer: ['a', 'b', 'c'], studentAnswer: null });
        assert.deepEqual(view.studentPositions, []);
        assert.equal(view.items.length, 3);
    });

    await t.test('id lạ -> -1; câu đã bị sửa/xóa mục -> text rỗng, không crash', () => {
        const view = buildOrderingResultView(
            { items: [{ id: 'a', text: 'Bước A' }] },
            { correctAnswer: ['a', 'b'], studentAnswer: ['zzz', 'a'] }
        );
        assert.deepEqual(view.studentPositions, [-1, 0]);
        assert.deepEqual(view.items, ['Bước A', '']);
    });

    await t.test('đầu vào thiếu/hỏng không làm crash', () => {
        assert.deepEqual(buildOrderingResultView(undefined, undefined), { items: [], studentPositions: [] });
        assert.deepEqual(buildOrderingResultView({}, { correctAnswer: 'x', studentAnswer: 5 }), { items: [], studentPositions: [] });
    });

    await t.test('nối với gradeSubmission: kết quả thật từ chấm điểm ra đúng dữ liệu Xem lại', () => {
        const result = gradeSubmission([{ ...q, score: 3 }], { q1: ['a', 'c', 'b'] });
        const view = buildOrderingResultView(q, result.details[0]);
        assert.deepEqual(view.items, ['Bước A', 'Bước B', 'Bước C']);
        assert.deepEqual(view.studentPositions, [0, 2, 1]);
    });
});

// ---------------------------------------------------------------------------
// GĐ3.6.9 — details câu Sắp xếp lưu kèm itemTexts (cho màn Quản lý kết quả của giáo viên)
// ---------------------------------------------------------------------------

test('gradeSubmission — details câu Sắp xếp có itemTexts', async (t) => {
    const q = {
        id: 'q1', type: 'ordering', score: 2,
        items: [{ id: 'b', text: 'Bước B' }, { id: 'a', text: 'Bước A' }, { id: 'c' }, { text: 'mục không có id' }],
        correctOrder: ['a', 'b', 'c']
    };

    await t.test('itemTexts = { id: text }: mục thiếu text -> chuỗi rỗng, mục thiếu id bị bỏ qua', () => {
        const result = gradeSubmission([q], { q1: ['a', 'b', 'c'] });
        assert.deepEqual(result.details[0].itemTexts, { a: 'Bước A', b: 'Bước B', c: '' });
    });

    await t.test('câu học sinh bỏ qua vẫn có itemTexts (giáo viên cần xem thứ tự đúng)', () => {
        const result = gradeSubmission([q], {});
        assert.equal(result.details[0].skipped, true);
        assert.deepEqual(result.details[0].itemTexts, { a: 'Bước A', b: 'Bước B', c: '' });
    });

    await t.test('loại câu khác KHÔNG có field itemTexts', () => {
        const mc = { id: 'm1', type: 'multiple_choice', options: ['A', 'B'], correct_option: 0, score: 1 };
        const fill = { id: 'f1', type: 'fill_blank', score: 1, blanks: [{ acceptedAnswers: ['x'] }] };
        const result = gradeSubmission([mc, fill], { m1: 0, f1: ['x'] });
        result.details.forEach((d) => assert.equal('itemTexts' in d, false));
    });
});
