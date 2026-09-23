'use strict';

/**
 * tests/grading.test.js — GĐ 0.1 (BACKEND AN TOÀN + NỀN TẢNG)
 *
 * Test cho lib/grading.js — dùng module test tích hợp sẵn của Node.js
 * (node:test + node:assert), KHÔNG cần cài thêm gì (không Jest, không
 * Firebase Admin, không biến môi trường). Chạy bằng:
 *
 *   npm test
 *   # hoặc trực tiếp:
 *   node --test tests
 *
 * Mục tiêu (theo đúng yêu cầu 0.1): đảm bảo sửa backend không làm sai
 * điểm hàng loạt. Bao phủ:
 *   - getCorrectIndicesServer (đọc đáp án đúng ở mọi schema cũ/mới)
 *   - sanitizeQuestionForClient (không được lộ đáp án đúng ra client)
 *   - gradeSubmission (logic chấm điểm thật dùng ở /api/submit-exam)
 *   - test case đúng/sai, dữ liệu bất thường, và mô phỏng luồng "submit thật"
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    getCorrectIndicesServer,
    getCorrectIndexServer,
    getOptionTextsServer,
    sanitizeQuestionForClient,
    isManualQuestionServer,
    isAllowedUploadUrl,
    extractManualAnswerServer,
    gradeSubmission
} = require('../lib/grading');

// ============================================================================
// getCorrectIndicesServer — đọc đáp án đúng, hỗ trợ 3 dạng schema
// ============================================================================
test('getCorrectIndicesServer', async (t) => {
    await t.test('schema MỚI: correct_option là number -> mảng 1 phần tử', () => {
        assert.deepEqual(getCorrectIndicesServer({ correct_option: 2 }), [2]);
    });

    await t.test('schema MỚI: correct_option là number[] (multiple_answer)', () => {
        assert.deepEqual(getCorrectIndicesServer({ correct_option: [0, 2] }), [0, 2]);
    });

    await t.test('schema MỚI: correct_option là number[] lẫn giá trị bẩn -> lọc bỏ non-number', () => {
        assert.deepEqual(getCorrectIndicesServer({ correct_option: [0, '1', null, 2] }), [0, 2]);
    });

    await t.test('schema MỚI: correct_option null (essay/chưa xác định) -> mảng rỗng', () => {
        assert.deepEqual(getCorrectIndicesServer({ correct_option: null }), []);
    });

    await t.test('schema CŨ 1: answers[].correct -> trả về chỉ số các phần tử correct:true', () => {
        const q = {
            answers: [
                { text: 'A', correct: false },
                { text: 'B', correct: true },
                { text: 'C', correct: false }
            ]
        };
        assert.deepEqual(getCorrectIndicesServer(q), [1]);
    });

    await t.test('schema CŨ 1: nhiều đáp án đúng cùng lúc', () => {
        const q = {
            answers: [
                { text: 'A', correct: true },
                { text: 'B', correct: false },
                { text: 'C', correct: true }
            ]
        };
        assert.deepEqual(getCorrectIndicesServer(q), [0, 2]);
    });

    await t.test('schema CŨ 1: phần tử answers bị null/undefined không làm crash', () => {
        const q = { answers: [null, { text: 'B', correct: true }, undefined] };
        assert.deepEqual(getCorrectIndicesServer(q), [1]);
    });

    await t.test('schema CŨ 2: options[] + correctAnswer (number)', () => {
        assert.deepEqual(getCorrectIndicesServer({ options: ['A', 'B', 'C'], correctAnswer: 1 }), [1]);
    });

    await t.test('không có field nào xác định đáp án đúng -> mảng rỗng', () => {
        assert.deepEqual(getCorrectIndicesServer({ question_text: 'Câu hỏi tự luận' }), []);
    });

    await t.test('correct_option ưu tiên hơn nếu tồn tại cả 2 schema (dữ liệu lai do migrate dở dang)', () => {
        const q = { correct_option: 1, correctAnswer: 0 };
        assert.deepEqual(getCorrectIndicesServer(q), [1]);
    });
});

test('getCorrectIndexServer (tương thích ngược — chỉ số đầu tiên)', () => {
    assert.equal(getCorrectIndexServer({ correct_option: [2, 0] }), 2);
    assert.equal(getCorrectIndexServer({ correct_option: 3 }), 3);
    assert.equal(getCorrectIndexServer({ question_text: 'không có đáp án' }), -1);
});

test('getOptionTextsServer', async (t) => {
    await t.test('schema MỚI: options: string[]', () => {
        assert.deepEqual(getOptionTextsServer({ options: ['A', 'B'] }), ['A', 'B']);
    });

    await t.test('schema CŨ: answers[{text}]', () => {
        assert.deepEqual(
            getOptionTextsServer({ answers: [{ text: 'A', correct: true }, { text: 'B', correct: false }] }),
            ['A', 'B']
        );
    });

    await t.test('answers có phần tử thiếu text -> trả chuỗi rỗng thay vì crash', () => {
        assert.deepEqual(getOptionTextsServer({ answers: [{ correct: true }, { text: 'B' }] }), ['', 'B']);
    });

    await t.test('không có options/answers -> mảng rỗng', () => {
        assert.deepEqual(getOptionTextsServer({}), []);
    });
});

// ============================================================================
// sanitizeQuestionForClient — TUYỆT ĐỐI không được lộ đáp án đúng
// ============================================================================
test('sanitizeQuestionForClient', async (t) => {
    await t.test('xoá correct_option (schema mới)', () => {
        const clean = sanitizeQuestionForClient({ id: 'q1', question_text: 'X', options: ['A', 'B'], correct_option: 1 });
        assert.equal('correct_option' in clean, false);
        assert.equal(clean.question_text, 'X');
        assert.deepEqual(clean.options, ['A', 'B']);
    });

    await t.test('xoá correct_option dạng mảng (multiple_answer)', () => {
        const clean = sanitizeQuestionForClient({ id: 'q1', correct_option: [0, 2] });
        assert.equal('correct_option' in clean, false);
    });

    await t.test('xoá "correct" trong từng phần tử answers[] nhưng giữ text (schema cũ)', () => {
        const clean = sanitizeQuestionForClient({
            id: 'q1',
            answers: [{ text: 'A', correct: true }, { text: 'B', correct: false }]
        });
        assert.deepEqual(clean.answers, [{ text: 'A' }, { text: 'B' }]);
        clean.answers.forEach((a) => assert.equal('correct' in a, false));
    });

    await t.test('xoá correctAnswer (schema cũ 2)', () => {
        const clean = sanitizeQuestionForClient({ id: 'q1', options: ['A', 'B'], correctAnswer: 1 });
        assert.equal('correctAnswer' in clean, false);
    });

    await t.test('xoá essayAnswer và explanation (không được lộ lời giải/đáp án mẫu)', () => {
        const clean = sanitizeQuestionForClient({
            id: 'q1',
            type: 'essay',
            essayAnswer: 'Đáp án mẫu bí mật',
            explanation: 'Lời giải bí mật'
        });
        assert.equal('essayAnswer' in clean, false);
        assert.equal('explanation' in clean, false);
    });

    await t.test('image_url: ưu tiên image_url nếu có, vẫn đọc "image" (schema cũ) nếu thiếu image_url', () => {
        const cleanNew = sanitizeQuestionForClient({ id: 'q1', image_url: 'https://x/a.png' });
        assert.equal(cleanNew.image_url, 'https://x/a.png');
        assert.equal('image' in cleanNew, false);

        const cleanOld = sanitizeQuestionForClient({ id: 'q1', image: 'https://x/b.png' });
        assert.equal(cleanOld.image_url, 'https://x/b.png');
        assert.equal('image' in cleanOld, false);
    });

    await t.test('không có ảnh -> image_url luôn là chuỗi rỗng, không phải undefined', () => {
        const clean = sanitizeQuestionForClient({ id: 'q1' });
        assert.equal(clean.image_url, '');
    });

    await t.test('không làm biến dạng object gốc truyền vào (immutable input)', () => {
        const original = { id: 'q1', correct_option: 1, options: ['A', 'B'] };
        const snapshot = JSON.parse(JSON.stringify(original));
        sanitizeQuestionForClient(original);
        assert.deepEqual(original, snapshot);
    });
});

// ============================================================================
// gradeSubmission — LOGIC CHẤM ĐIỂM THẬT dùng ở /api/submit-exam
// ============================================================================
test('gradeSubmission — trắc nghiệm đơn / true_false', async (t) => {
    await t.test('chọn đúng đáp án -> isCorrect true, cộng điểm đầy đủ', () => {
        const questions = [{ id: 'q1', type: 'multiple_choice', correct_option: 1, score: 2 }];
        const result = gradeSubmission(questions, { q1: 1 });
        assert.equal(result.correctCount, 1);
        assert.equal(result.earnedPoints, 2);
        assert.equal(result.totalPoints, 2);
        assert.equal(result.autoScore, 10);
        assert.equal(result.score, 10);
        assert.equal(result.gradingStatus, 'graded');
        assert.deepEqual(result.details[0], {
            questionId: 'q1',
            studentAnswer: 1,
            correctAnswer: 1,
            isCorrect: true,
            points: 2,
            explanation: ''
        });
    });

    await t.test('chọn sai đáp án -> isCorrect false, không cộng điểm', () => {
        const questions = [{ id: 'q1', type: 'multiple_choice', correct_option: 1, score: 1 }];
        const result = gradeSubmission(questions, { q1: 0 });
        assert.equal(result.correctCount, 0);
        assert.equal(result.earnedPoints, 0);
        assert.equal(result.details[0].isCorrect, false);
        assert.equal(result.details[0].correctAnswer, 1);
    });

    await t.test('không trả lời (bỏ qua) -> studentAnswer null, isCorrect false', () => {
        const questions = [{ id: 'q1', type: 'multiple_choice', correct_option: 0 }];
        const result = gradeSubmission(questions, {});
        assert.equal(result.details[0].studentAnswer, null);
        assert.equal(result.details[0].isCorrect, false);
    });

    await t.test('không có "score" trên câu hỏi -> mặc định 1 điểm', () => {
        const questions = [{ id: 'q1', type: 'multiple_choice', correct_option: 0 }];
        const result = gradeSubmission(questions, { q1: 0 });
        assert.equal(result.details[0].points, 1);
        assert.equal(result.totalPoints, 1);
    });

    await t.test('score = 0 hoặc âm trên câu hỏi (dữ liệu bất thường) -> vẫn fallback về 1 điểm', () => {
        const questions = [
            { id: 'q1', type: 'multiple_choice', correct_option: 0, score: 0 },
            { id: 'q2', type: 'multiple_choice', correct_option: 0, score: -5 }
        ];
        const result = gradeSubmission(questions, { q1: 0, q2: 0 });
        assert.equal(result.totalPoints, 2);
        assert.equal(result.earnedPoints, 2);
    });

    await t.test('câu hỏi không có correct_option nào xác định (lỗi bóc tách) -> luôn sai dù học sinh trả lời gì', () => {
        const questions = [{ id: 'q1', type: 'multiple_choice', score: 1 }];
        const result = gradeSubmission(questions, { q1: 0 });
        assert.equal(result.details[0].isCorrect, false);
        assert.equal(result.details[0].correctAnswer, -1);
    });

    await t.test('dữ liệu bất thường: rawStudentAnswer là chuỗi thay vì number -> coi như chưa trả lời', () => {
        const questions = [{ id: 'q1', type: 'multiple_choice', correct_option: 1 }];
        const result = gradeSubmission(questions, { q1: '1' });
        assert.equal(result.details[0].studentAnswer, null);
        assert.equal(result.details[0].isCorrect, false);
    });
});

test('gradeSubmission — multiple_answer (nhiều đáp án đúng)', async (t) => {
    await t.test('chọn ĐÚNG HẾT các đáp án đúng, không thừa không thiếu -> đúng', () => {
        const questions = [{ id: 'q1', type: 'multiple_answer', correct_option: [0, 2], score: 3 }];
        const result = gradeSubmission(questions, { q1: [2, 0] }); // thứ tự khác nhau vẫn phải đúng
        assert.equal(result.details[0].isCorrect, true);
        assert.equal(result.earnedPoints, 3);
    });

    await t.test('chọn THIẾU 1 đáp án đúng -> sai', () => {
        const questions = [{ id: 'q1', type: 'multiple_answer', correct_option: [0, 2] }];
        const result = gradeSubmission(questions, { q1: [0] });
        assert.equal(result.details[0].isCorrect, false);
    });

    await t.test('chọn THỪA 1 đáp án đúng (chọn cả đáp án sai) -> sai', () => {
        const questions = [{ id: 'q1', type: 'multiple_answer', correct_option: [0, 2] }];
        const result = gradeSubmission(questions, { q1: [0, 1, 2] });
        assert.equal(result.details[0].isCorrect, false);
    });

    await t.test('gửi 1 number thay vì mảng (client cũ/lỗi FE) -> vẫn nhận diện được', () => {
        const questions = [{ id: 'q1', type: 'multiple_answer', correct_option: [0] }];
        const result = gradeSubmission(questions, { q1: 0 });
        assert.equal(result.details[0].isCorrect, true);
        assert.deepEqual(result.details[0].studentAnswer, [0]);
    });

    await t.test('mảng chọn lẫn giá trị bẩn (string/null) -> lọc bỏ trước khi so sánh', () => {
        const questions = [{ id: 'q1', type: 'multiple_answer', correct_option: [0, 1] }];
        const result = gradeSubmission(questions, { q1: [0, '1', null, 1] });
        assert.equal(result.details[0].isCorrect, true);
    });

    await t.test('không chọn gì (mảng rỗng) -> studentAnswer null, không phải mảng rỗng', () => {
        const questions = [{ id: 'q1', type: 'multiple_answer', correct_option: [0, 1] }];
        const result = gradeSubmission(questions, { q1: [] });
        assert.equal(result.details[0].studentAnswer, null);
        assert.equal(result.details[0].isCorrect, false);
    });

    await t.test('correct_option rỗng (câu hỏi lỗi, không có đáp án đúng nào) -> luôn sai', () => {
        const questions = [{ id: 'q1', type: 'multiple_answer', correct_option: [] }];
        const result = gradeSubmission(questions, { q1: [] });
        assert.equal(result.details[0].isCorrect, false);
    });
});

test('gradeSubmission — câu hỏi CHẤM TAY (essay/upload)', async (t) => {
    await t.test('có câu essay -> gom vào manualItems, KHÔNG tính vào details/totalPoints', () => {
        const questions = [
            { id: 'q1', type: 'multiple_choice', correct_option: 0, score: 1 },
            { id: 'q2', type: 'essay', score: 5 }
        ];
        const result = gradeSubmission(questions, { q1: 0, q2: 'Bài làm tự luận của em...' });

        assert.equal(result.manualItems.length, 1);
        assert.equal(result.manualItems[0].questionId, 'q2');
        assert.equal(result.manualItems[0].points, 5);
        assert.equal(result.manualItems[0].essayAnswer, 'Bài làm tự luận của em...');
        assert.equal(result.details.length, 1); // chỉ q1 nằm trong details
        assert.equal(result.totalPoints, 1); // KHÔNG cộng điểm câu essay vào totalPoints
    });

    await t.test('có câu chấm tay -> gradingStatus = pending, score = null (chưa có điểm chính thức)', () => {
        const questions = [
            { id: 'q1', type: 'multiple_choice', correct_option: 0, score: 1 },
            { id: 'q2', type: 'upload', score: 5 }
        ];
        const result = gradeSubmission(questions, { q1: 0 });

        assert.equal(result.hasManualItems, true);
        assert.equal(result.gradingStatus, 'pending');
        assert.equal(result.score, null);
        // autoScore vẫn tính riêng phần trắc nghiệm để giáo viên tham khảo
        assert.equal(result.autoScore, 10);
    });

    await t.test('KHÔNG có câu chấm tay -> gradingStatus = graded, score có giá trị số', () => {
        const questions = [{ id: 'q1', type: 'multiple_choice', correct_option: 0 }];
        const result = gradeSubmission(questions, { q1: 0 });
        assert.equal(result.hasManualItems, false);
        assert.equal(result.gradingStatus, 'graded');
        assert.notEqual(result.score, null);
    });

    await t.test('upload: chỉ chấp nhận URL Cloudinary https hợp lệ, từ chối link lạ', () => {
        const questions = [{ id: 'q1', type: 'upload', score: 2 }];
        const resultGood = gradeSubmission(questions, { q1: 'https://res.cloudinary.com/demo/file.pdf' });
        assert.equal(resultGood.manualItems[0].fileUrl, 'https://res.cloudinary.com/demo/file.pdf');

        const resultBad = gradeSubmission(questions, { q1: 'javascript:alert(1)' });
        assert.equal(resultBad.manualItems[0].fileUrl, '');
    });

    await t.test('essay không trả lời gì -> essayAnswer là chuỗi rỗng, không crash', () => {
        const questions = [{ id: 'q1', type: 'essay', score: 3 }];
        const result = gradeSubmission(questions, {});
        assert.equal(result.manualItems[0].essayAnswer, '');
    });

    await t.test('toàn bộ câu hỏi đều là chấm tay -> totalPoints = 0, autoScore = null (không chia cho 0)', () => {
        const questions = [{ id: 'q1', type: 'essay', score: 10 }];
        const result = gradeSubmission(questions, { q1: 'bài làm' });
        assert.equal(result.totalPoints, 0);
        assert.equal(result.autoScore, null);
        assert.equal(result.score, null); // vẫn null vì hasManualItems=true, không phải vì totalPoints=0
    });
});

test('gradeSubmission — mô phỏng "submit thật" (bài thi hỗn hợp nhiều loại câu)', async (t) => {
    const questions = [
        { id: 'q1', type: 'multiple_choice', correct_option: 1, score: 2 }, // đúng
        { id: 'q2', type: 'multiple_choice', correct_option: 0, score: 2 }, // sai
        { id: 'q3', type: 'multiple_answer', correct_option: [0, 1], score: 3 }, // đúng
        { id: 'q4', type: 'true_false', correct_option: 0, score: 1 }, // bỏ qua
        { id: 'q5', type: 'essay', score: 5 } // chấm tay
    ];
    const answers = {
        q1: 1,
        q2: 1, // sai
        q3: [1, 0],
        // q4 không trả lời
        q5: 'Bài luận của học sinh.'
    };

    await t.test('tổng hợp kết quả đúng cho toàn bộ bài thi', () => {
        const result = gradeSubmission(questions, answers);

        assert.equal(result.totalQuestions, 5);
        assert.equal(result.correctCount, 2); // q1, q3
        assert.equal(result.totalPoints, 8); // q1(2) + q2(2) + q3(3) + q4(1), KHÔNG tính q5 (chỉ essay/upload loại trừ)
        assert.equal(result.earnedPoints, 5); // q1(2) + q3(3)
        assert.equal(result.autoScore, 6.3); // 5/8 * 10, làm tròn 1 chữ số thập phân
        assert.equal(result.hasManualItems, true);
        assert.equal(result.gradingStatus, 'pending');
        assert.equal(result.score, null); // chờ giáo viên chấm q5

        assert.equal(result.manualItems.length, 1);
        assert.equal(result.manualItems[0].questionId, 'q5');

        assert.equal(result.details.length, 4); // q1,q2,q3,q4 (không có q5)
        const byId = Object.fromEntries(result.details.map((d) => [d.questionId, d]));
        assert.equal(byId.q1.isCorrect, true);
        assert.equal(byId.q2.isCorrect, false);
        assert.equal(byId.q3.isCorrect, true);
        assert.equal(byId.q4.isCorrect, false);
        assert.equal(byId.q4.studentAnswer, null);
    });

    await t.test('dữ liệu answers hoàn toàn rỗng ({}) vẫn không crash, mọi câu tính là sai/bỏ qua', () => {
        const result = gradeSubmission(questions, {});
        assert.equal(result.correctCount, 0);
        assert.equal(result.earnedPoints, 0);
        result.details.forEach((d) => assert.equal(d.isCorrect, false));
    });

    await t.test('answers chứa questionId lạ (không thuộc bài thi) -> bị bỏ qua, không ảnh hưởng chấm điểm', () => {
        const result = gradeSubmission(questions, { ...answers, khongTonTai: 999 });
        assert.equal(result.correctCount, 2);
        assert.equal(result.totalQuestions, 5);
    });
});

test('gradeSubmission — bài thi rỗng (không có câu hỏi nào)', () => {
    const result = gradeSubmission([], {});
    assert.equal(result.totalQuestions, 0);
    assert.equal(result.correctCount, 0);
    assert.equal(result.totalPoints, 0);
    assert.equal(result.hasManualItems, false);
    assert.equal(result.gradingStatus, 'graded');
    assert.equal(result.autoScore, null);
    assert.equal(result.score, 0); // không có manual, autoScore null -> score fallback 0
});

// ============================================================================
// Helper phụ trợ khác dùng trong chấm tay (isManualQuestionServer, isAllowedUploadUrl)
// ============================================================================
test('isManualQuestionServer', () => {
    assert.equal(isManualQuestionServer({ type: 'essay' }), true);
    assert.equal(isManualQuestionServer({ type: 'upload' }), true);
    assert.equal(isManualQuestionServer({ type: 'multiple_choice' }), false);
    assert.equal(isManualQuestionServer(null), false);
});

test('isAllowedUploadUrl', () => {
    assert.equal(isAllowedUploadUrl('https://res.cloudinary.com/demo/image/upload/x.pdf'), true);
    assert.equal(isAllowedUploadUrl('https://sub.cloudinary.com/x.pdf'), true);
    assert.equal(isAllowedUploadUrl('http://res.cloudinary.com/x.pdf'), false); // không phải https
    assert.equal(isAllowedUploadUrl('https://evil.com/fake-cloudinary.com'), false);
    assert.equal(isAllowedUploadUrl('javascript:alert(1)'), false);
    assert.equal(isAllowedUploadUrl(''), false);
    assert.equal(isAllowedUploadUrl(null), false);
    assert.equal(isAllowedUploadUrl(123), false);
});

test('extractManualAnswerServer', async (t) => {
    await t.test('essay: chấp nhận string thuần', () => {
        const r = extractManualAnswerServer({ type: 'essay' }, '  bài làm  ');
        assert.equal(r.essayAnswer, 'bài làm');
    });

    await t.test('essay: chấp nhận object { essayAnswer }', () => {
        const r = extractManualAnswerServer({ type: 'essay' }, { essayAnswer: 'nội dung' });
        assert.equal(r.essayAnswer, 'nội dung');
    });

    await t.test('essay: cắt bớt nếu vượt quá độ dài tối đa', () => {
        const longText = 'a'.repeat(25000);
        const r = extractManualAnswerServer({ type: 'essay' }, longText);
        assert.equal(r.essayAnswer.length, 20000);
    });

    await t.test('upload: object { fileUrl, fileName }', () => {
        const r = extractManualAnswerServer(
            { type: 'upload' },
            { fileUrl: 'https://res.cloudinary.com/x.pdf', fileName: 'baitap.pdf' }
        );
        assert.equal(r.fileUrl, 'https://res.cloudinary.com/x.pdf');
        assert.equal(r.fileName, 'baitap.pdf');
    });
});
