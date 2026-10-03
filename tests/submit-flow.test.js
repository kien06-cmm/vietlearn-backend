'use strict';

/**
 * tests/submit-flow.test.js — GĐ3.8A-3 (kiểm tra format answer: frontend -> submit -> backend -> grading)
 *
 * Mô phỏng đúng đường đi thật của /api/submit-exam:
 *   câu hỏi gốc -> sanitizeQuestionForClient() (bản học sinh nhìn thấy)
 *   -> đáp án theo format lam-bai/questions/* -> JSON (qua mạng)
 *   -> translateMatchingAnswer() (chỉ matching) -> gradeSubmission()
 *
 * Hồi quy cho lỗi: câu Tự luận type 'open_ended' (alias của 'essay') bị mất nội dung bài làm
 * vì extractManualAnswerServer() so sánh thẳng q.type === 'essay'.
 *
 * Chạy:  npm test   (hoặc: node --test tests)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    sanitizeQuestionForClient,
    translateMatchingAnswer,
    gradeSubmission
} = require('../lib/grading');

const EXAM_ID = 'exam1';
const STUDENT_ID = 'student1';

const seedOf = (q) => `${EXAM_ID}_${STUDENT_ID}_${q.id}`;
const roundTrip = (value) => JSON.parse(JSON.stringify(value));

// Đúng như routes/submit.js: dịch token matching rồi mới chấm.
function submit(questions, clientAnswers) {
    const safeAnswers = roundTrip(clientAnswers);
    const translated = { ...safeAnswers };
    questions.forEach((q) => {
        if (q.type === 'matching') {
            translated[q.id] = translateMatchingAnswer(q, safeAnswers[q.id], seedOf(q));
        }
    });
    return gradeSubmission(questions, translated);
}

test('multiple_choice — đáp án là số chỉ số', () => {
    const q = { id: 'q_mc', type: 'multiple_choice', question_text: '1+1?', options: ['1', '2', '3'], correct_option: 1 };

    const right = submit([q], { q_mc: 1 });
    assert.equal(right.details[0].isCorrect, true);
    assert.equal(right.score, 10);

    const wrong = submit([q], { q_mc: 0 });
    assert.equal(wrong.details[0].isCorrect, false);
    assert.equal(wrong.score, 0);

    const skipped = submit([q], {});
    assert.equal(skipped.skippedCount, 1);
});

test('multi_select (alias multiple_answer) — đáp án là mảng số, phải đúng cả tập', () => {
    const q = { id: 'q_ms', type: 'multi_select', question_text: 'Số chẵn?', options: ['1', '2', '3', '4'], correct_option: [1, 3] };

    assert.equal(submit([q], { q_ms: [1, 3] }).details[0].isCorrect, true);
    assert.equal(submit([q], { q_ms: [1] }).details[0].isCorrect, false);
    assert.equal(submit([q], { q_ms: [0, 1, 3] }).details[0].isCorrect, false);
});

test('matching — client gửi { leftId: "token" }, backend dịch token về id thật', () => {
    const q = {
        id: 'q_match',
        type: 'matching',
        question_text: 'Ghép thủ đô',
        pairs: [
            { id: 'p1', left: 'Việt Nam', right: 'Hà Nội' },
            { id: 'p2', left: 'Pháp', right: 'Paris' },
            { id: 'p3', left: 'Nhật', right: 'Tokyo' }
        ]
    };

    const view = sanitizeQuestionForClient(q, seedOf(q));
    assert.equal(view.pairs.right.every((r) => r.id === undefined), true, 'cột phải không được lộ id thật');

    const tokenOfRight = (text) => String(view.pairs.right.find((r) => r.text === text).token);

    const correctAnswer = { p1: tokenOfRight('Hà Nội'), p2: tokenOfRight('Paris'), p3: tokenOfRight('Tokyo') };
    const right = submit([q], { q_match: correctAnswer });
    assert.equal(right.details[0].isCorrect, true);

    const swapped = { p1: tokenOfRight('Paris'), p2: tokenOfRight('Hà Nội'), p3: tokenOfRight('Tokyo') };
    const partial = submit([q], { q_match: swapped });
    assert.equal(partial.details[0].isCorrect, false);
    assert.ok(Math.abs(partial.details[0].partialFraction - 1 / 3) < 1e-9);

    // null / chuỗi rỗng không được tính thành token 0
    const tampered = submit([q], { q_match: { p1: null, p2: '', p3: '' } });
    assert.equal(tampered.details[0].skipped, true);
});

test('ordering — client gửi mảng id (chuỗi), kể cả khi id gốc là số', () => {
    const qStr = {
        id: 'q_ord_s',
        type: 'ordering',
        question_text: 'Sắp xếp',
        items: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }],
        correctOrder: ['a', 'b', 'c']
    };
    const qNum = {
        id: 'q_ord_n',
        type: 'ordering',
        question_text: 'Sắp xếp',
        items: [{ id: 1, text: 'A' }, { id: 2, text: 'B' }, { id: 3, text: 'C' }],
        correctOrder: [1, 2, 3]
    };

    [qStr, qNum].forEach((q) => {
        const view = sanitizeQuestionForClient(q, seedOf(q));
        const correct = q.correctOrder.map(String);
        const studentOrder = view.items.map((it) => String(it.id)).sort((x, y) => correct.indexOf(x) - correct.indexOf(y));

        assert.equal(submit([q], { [q.id]: studentOrder }).details[0].isCorrect, true, `đúng thứ tự (${q.id})`);

        const reversed = [...studentOrder].reverse();
        assert.equal(submit([q], { [q.id]: reversed }).details[0].isCorrect, false, `ngược thứ tự (${q.id})`);
    });
});

test('drag_drop — client gửi { zoneId: itemId }, ô trống thì không có key', () => {
    const q = {
        id: 'q_dd',
        type: 'drag_drop',
        question_text: 'Kéo thả',
        dropZones: [{ id: 'z1', label: 'Ô 1' }, { id: 'z2', label: 'Ô 2' }],
        dragItems: [{ id: 'i1', text: 'T1' }, { id: 'i2', text: 'T2' }, { id: 'i3', text: 'Nhiễu' }],
        correctMap: { z1: 'i1', z2: 'i2' }
    };

    const view = sanitizeQuestionForClient(q, seedOf(q));
    assert.equal(view.correctMap, undefined, 'không được lộ correctMap');

    const full = submit([q], { q_dd: { z1: 'i1', z2: 'i2' } });
    assert.equal(full.details[0].isCorrect, true);

    const half = submit([q], { q_dd: { z1: 'i1' } });
    assert.equal(half.details[0].isCorrect, false);
    assert.equal(half.details[0].skipped, false);
    assert.equal(half.details[0].partialFraction, 0.5);

    assert.equal(submit([q], { q_dd: {} }).details[0].skipped, true);
});

test('fill_blank — client gửi mảng chuỗi theo thứ tự ô, không phân biệt hoa/thường và dấu', () => {
    const q = {
        id: 'q_fb',
        type: 'fill_blank',
        question_text: 'Thủ đô là ___, sông chảy qua là ___.',
        blanks: [{ acceptedAnswers: ['Hà Nội'] }, { acceptedAnswers: ['sông Hồng'] }]
    };

    const view = sanitizeQuestionForClient(q, seedOf(q));
    assert.equal(view.blanks.length, 2);
    assert.equal(view.blanks.every((b) => b.acceptedAnswers === undefined), true, 'không được lộ đáp án chấp nhận');

    assert.equal(submit([q], { q_fb: ['ha noi', 'Sông Hồng'] }).details[0].isCorrect, true);
    assert.equal(submit([q], { q_fb: ['ha noi', ''] }).details[0].partialFraction, 0.5);
});

test('essay / open_ended — nội dung bài làm phải được giữ lại cho giáo viên chấm', () => {
    ['essay', 'open_ended'].forEach((type) => {
        const q = { id: `q_${type}`, type, question_text: 'Trình bày quan điểm' };
        const result = submit([q], { [q.id]: '  Bài làm của em  ' });

        assert.equal(result.hasManualItems, true, type);
        assert.equal(result.gradingStatus, 'pending', type);
        assert.equal(result.score, null, type);
        assert.equal(result.manualItems.length, 1, type);
        assert.equal(result.manualItems[0].essayAnswer, 'Bài làm của em', `${type}: mất nội dung bài làm`);
    });
});

test('đề trộn nhiều loại — mỗi câu đọc đúng format của mình', () => {
    const mc = { id: 'm1', type: 'multiple_choice', question_text: 'MC', options: ['a', 'b'], correct_option: 0 };
    const ord = {
        id: 'o1',
        type: 'ordering',
        question_text: 'ORD',
        items: [{ id: 'x', text: 'X' }, { id: 'y', text: 'Y' }],
        correctOrder: ['x', 'y']
    };
    const dd = {
        id: 'd1',
        type: 'drag_drop',
        question_text: 'DD',
        dropZones: [{ id: 'z', label: 'Z' }],
        dragItems: [{ id: 'k', text: 'K' }],
        correctMap: { z: 'k' }
    };

    const result = submit([mc, ord, dd], { m1: 0, o1: ['x', 'y'], d1: { z: 'k' } });
    assert.equal(result.correctCount, 3);
    assert.equal(result.score, 10);
});
