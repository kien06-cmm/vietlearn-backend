'use strict';

/**
 * tests/dragdrop.test.js — GĐ3.7B (câu "Kéo-thả", type: 'drag_drop')
 *
 * Test đơn vị cho lib/dragdrop.js: chấm điểm từng phần, dữ liệu "Xem lại" cho ketqua.js
 * và dữ liệu file ôn tập. Chỉ require './lib/dragdrop' (không cần Firebase/env).
 * Luồng đầy đủ qua gradeSubmission()/sanitizeQuestionForClient() nằm ở tests/dragdrop-flow.test.js.
 *
 * Chạy:  npm test   (hoặc: node --test tests)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    getDragDropSpec,
    buildDragDropTexts,
    gradeDragDrop,
    buildDragDropResultView,
    buildDragDropReview
} = require('../lib/dragdrop');

function makeQuestion(overrides) {
    return {
        id: 'q1',
        type: 'drag_drop',
        question_text: 'Ghép quốc gia với thủ đô',
        score: 2,
        dropZones: [
            { id: 'z1', label: 'Việt Nam' },
            { id: 'z2', label: 'Pháp' },
            { id: 'z3', label: 'Nhật Bản' }
        ],
        dragItems: [
            { id: 'i1', text: 'Hà Nội' },
            { id: 'i2', text: 'Paris' },
            { id: 'i3', text: 'Tokyo' },
            { id: 'i4', text: 'Bangkok' }   // thẻ gây nhiễu, không thuộc ô nào
        ],
        correctMap: { z1: 'i1', z2: 'i2', z3: 'i3' },
        ...overrides
    };
}

test('gradeDragDrop — chấm từng phần theo số ô đặt đúng thẻ', async (t) => {
    const q = makeQuestion();

    await t.test('đúng hết 3 ô -> fraction 1, không bỏ qua', () => {
        const r = gradeDragDrop(q, { z1: 'i1', z2: 'i2', z3: 'i3' });
        assert.equal(r.fraction, 1);
        assert.equal(r.skipped, false);
        assert.deepEqual(r.studentAnswerNormalized, { z1: 'i1', z2: 'i2', z3: 'i3' });
    });

    await t.test('đúng 1/3 ô (1 ô sai, 1 ô bỏ trống) -> fraction 1/3', () => {
        const r = gradeDragDrop(q, { z1: 'i1', z2: 'i3' });
        assert.equal(r.fraction, 1 / 3);
        assert.equal(r.skipped, false);
    });

    await t.test('sai hết -> fraction 0 nhưng KHÔNG phải bỏ qua', () => {
        const r = gradeDragDrop(q, { z1: 'i2', z2: 'i3', z3: 'i1' });
        assert.equal(r.fraction, 0);
        assert.equal(r.skipped, false);
    });

    await t.test('thả thẻ gây nhiễu vào ô -> tính sai', () => {
        const r = gradeDragDrop(q, { z1: 'i4', z2: 'i2', z3: 'i3' });
        assert.equal(r.fraction, 2 / 3);
    });

    await t.test('đáp án đúng trả về là danh sách { zoneId, itemId } theo thứ tự ô, id dạng chuỗi', () => {
        const r = gradeDragDrop(q, { z1: 'i1' });
        assert.deepEqual(r.correctAnswerForDetail, [
            { zoneId: 'z1', itemId: 'i1' },
            { zoneId: 'z2', itemId: 'i2' },
            { zoneId: 'z3', itemId: 'i3' }
        ]);
    });
});

test('gradeDragDrop — bỏ qua và dữ liệu lạ', async (t) => {
    const q = makeQuestion();

    await t.test('không gửi gì / rỗng / kiểu lạ -> skipped:true, studentAnswerNormalized = null', () => {
        [undefined, null, {}, [], ['i1'], 'i1', 5].forEach((raw) => {
            const r = gradeDragDrop(q, raw);
            assert.equal(r.skipped, true, `raw=${JSON.stringify(raw)}`);
            assert.equal(r.fraction, 0);
            assert.equal(r.studentAnswerNormalized, null);
        });
    });

    await t.test('id ô / id thẻ không tồn tại bị bỏ qua, không crash, KHÔNG tính là bỏ qua', () => {
        const r = gradeDragDrop(q, { zX: 'i1', z1: 'iX' });
        assert.equal(r.fraction, 0);
        assert.equal(r.skipped, false);
        assert.deepEqual(r.studentAnswerNormalized, {});
    });

    await t.test('giá trị không phải chuỗi/số bị bỏ qua', () => {
        const r = gradeDragDrop(q, { z1: {}, z2: ['i2'], z3: 'i3' });
        assert.equal(r.fraction, 1 / 3);
        assert.deepEqual(r.studentAnswerNormalized, { z3: 'i3' });
    });

    await t.test('1 thẻ nằm ở >= 2 ô (client thật không làm được) -> 0 điểm, KHÔNG phải bỏ qua', () => {
        const r = gradeDragDrop(q, { z1: 'i1', z2: 'i1', z3: 'i3' });
        assert.equal(r.fraction, 0);
        assert.equal(r.skipped, false);
    });

    await t.test('id dạng số vẫn chấm đúng (ép về chuỗi)', () => {
        const numeric = {
            id: 'q2',
            type: 'drag_drop',
            dropZones: [{ id: 1, label: 'A' }, { id: 2, label: 'B' }],
            dragItems: [{ id: 10, text: 'x' }, { id: 20, text: 'y' }],
            correctMap: { 1: 10, 2: 20 }
        };
        const r = gradeDragDrop(numeric, { 1: 10, 2: '20' });
        assert.equal(r.fraction, 1);
    });
});

test('gradeDragDrop — câu hỏi bị sửa hỏng không làm sai mẫu số điểm', async (t) => {
    await t.test('ô trỏ tới thẻ đã bị xoá khỏi dragItems không được tính vào tổng số ô chấm được', () => {
        const q = makeQuestion({ correctMap: { z1: 'i1', z2: 'i2', z3: 'i9' } });
        const r = gradeDragDrop(q, { z1: 'i1', z2: 'i2' });
        assert.equal(r.fraction, 1);
        assert.equal(r.correctAnswerForDetail.length, 2);
    });

    await t.test('ô không có trong correctMap không được tính', () => {
        const q = makeQuestion({ correctMap: { z1: 'i1' } });
        assert.equal(gradeDragDrop(q, { z1: 'i1' }).fraction, 1);
    });

    await t.test('không có ô nào chấm được -> fraction 0, không NaN', () => {
        const q = makeQuestion({ correctMap: {} });
        const r = gradeDragDrop(q, { z1: 'i1' });
        assert.equal(r.fraction, 0);
        assert.equal(r.skipped, false);
    });

    await t.test('correctMap sai kiểu (mảng) coi như rỗng', () => {
        const q = makeQuestion({ correctMap: ['i1', 'i2', 'i3'] });
        assert.equal(getDragDropSpec(q).gradable.length, 0);
    });
});

test('buildDragDropResultView — dữ liệu "Xem lại" cho ketqua.js', async (t) => {
    const q = makeQuestion();

    function makeDetail(rawAnswer, question) {
        const graded = gradeDragDrop(question || q, rawAnswer);
        return {
            correctAnswer: graded.correctAnswerForDetail,
            studentAnswer: graded.studentAnswerNormalized,
            dragTexts: buildDragDropTexts(question || q)
        };
    }

    await t.test('mỗi ô có nhãn, thẻ đúng, thẻ học sinh thả, cờ placed / isCorrect', () => {
        const view = buildDragDropResultView(q, makeDetail({ z1: 'i1', z2: 'i3' }));
        assert.deepEqual(view.zones, [
            { label: 'Việt Nam', correctText: 'Hà Nội', studentText: 'Hà Nội', placed: true, isCorrect: true },
            { label: 'Pháp', correctText: 'Paris', studentText: 'Tokyo', placed: true, isCorrect: false },
            { label: 'Nhật Bản', correctText: 'Tokyo', studentText: '', placed: false, isCorrect: false }
        ]);
    });

    await t.test('thẻ gây nhiễu = thẻ không thuộc ô nào', () => {
        const view = buildDragDropResultView(q, makeDetail({ z1: 'i1' }));
        assert.deepEqual(view.distractors, ['Bangkok']);
    });

    await t.test('bài bỏ qua (studentAnswer = null) -> mọi ô placed:false', () => {
        const view = buildDragDropResultView(q, makeDetail(undefined));
        assert.equal(view.zones.length, 3);
        assert.equal(view.zones.every((z) => z.placed === false && z.isCorrect === false && z.studentText === ''), true);
    });

    await t.test('giáo viên sửa câu SAU khi học sinh nộp -> màn Xem lại vẫn theo bản chụp lúc chấm', () => {
        const detail = makeDetail({ z1: 'i1', z2: 'i2', z3: 'i3' });
        const edited = makeQuestion({
            dropZones: q.dropZones.map((z) => (z.id === 'z2' ? { ...z, label: 'Cộng hoà Pháp' } : z)),
            dragItems: q.dragItems.map((it) => (it.id === 'i2' ? { ...it, text: 'Paris (Pháp)' } : it))
        });
        const view = buildDragDropResultView(edited, detail);
        assert.equal(view.zones[1].label, 'Pháp');
        assert.equal(view.zones[1].correctText, 'Paris');
        assert.equal(view.zones[1].studentText, 'Paris');
    });

    await t.test('thiếu bản chụp (bài cũ) -> dùng nội dung hiện tại của câu hỏi', () => {
        const detail = makeDetail({ z1: 'i1' });
        delete detail.dragTexts;
        const view = buildDragDropResultView(q, detail);
        assert.equal(view.zones[0].label, 'Việt Nam');
        assert.equal(view.zones[0].studentText, 'Hà Nội');
    });

    await t.test('dữ liệu hỏng không làm crash', () => {
        assert.deepEqual(buildDragDropResultView(q, {}).zones, []);
        assert.deepEqual(buildDragDropResultView(q, null).zones, []);
        assert.deepEqual(buildDragDropResultView({}, { correctAnswer: [{ zoneId: 'z1', itemId: 'i1' }] }).zones, [
            { label: '', correctText: '', studentText: '', placed: false, isCorrect: false }
        ]);
    });
});

test('buildDragDropReview — file ôn tập', async (t) => {
    await t.test('trả các cặp ô -> thẻ đúng theo thứ tự ô + thẻ gây nhiễu', () => {
        assert.deepEqual(buildDragDropReview(makeQuestion()), {
            dragDropPairs: [
                { label: 'Việt Nam', text: 'Hà Nội' },
                { label: 'Pháp', text: 'Paris' },
                { label: 'Nhật Bản', text: 'Tokyo' }
            ],
            dragDropDistractors: ['Bangkok']
        });
    });

    await t.test('câu không có gì chấm được -> danh sách cặp rỗng', () => {
        assert.deepEqual(buildDragDropReview(makeQuestion({ correctMap: {} })).dragDropPairs, []);
    });
});