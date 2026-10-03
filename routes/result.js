// Router kết quả: học sinh xem lại bài làm chi tiết và lấy dữ liệu để tải file ôn tập.

const express = require('express');
const {
    getOptionTextsServer,
    toReviewQuestionServer,
    buildOrderingResultView,
    buildDragDropResultView,
    normalizeQuestionType
} = require('../lib/grading');

/**
 * Câu trả lời "chưa làm": null/undefined, chuỗi trắng, mảng rỗng hoặc toàn phần tử trắng.
 * Số 0 là đáp án hợp lệ (đáp án A có chỉ số 0). Object (ghép đôi / kéo-thả) do cờ d.skipped quyết định, không xét ở đây.
 */
function isBlankAnswer(value) {
    if (value === null || value === undefined) return true;
    if (typeof value === 'string') return value.trim() === '';
    if (Array.isArray(value)) return value.every(isBlankAnswer);
    return false;
}

/**
 * Loại câu của 1 phần tử details. Ưu tiên type của câu hỏi (đã giải alias, vd multi_select -> multiple_answer).
 * Câu hỏi đã bị xoá khỏi ngân hàng (q = {}) thì suy ra từ dữ liệu đã lưu trong details, để màn Xem lại
 * vẫn dựng đúng thẻ thay vì rơi về trắc nghiệm rỗng.
 */
function resolveDetailType(q, d) {
    if (typeof q.type === 'string' && q.type) return normalizeQuestionType(q.type);
    if (d && d.dragTexts && typeof d.dragTexts === 'object') return 'drag_drop';
    if (d && d.itemTexts && typeof d.itemTexts === 'object') return 'ordering';
    const correct = Array.isArray(d && d.correctAnswer) ? d.correctAnswer : [];
    if (correct.length > 0 && correct.every((b) => b && typeof b === 'object' && Array.isArray(b.acceptedAnswers))) return 'fill_blank';
    if (correct.length > 0 && correct.every((p) => p && typeof p === 'object' && 'left' in p && 'right' in p)) return 'matching';
    return 'multiple_choice';
}

function createResultRouter({ dbAdmin, verifyFirebaseToken, examHelpers }) {
    const { fetchQuestionsByIds, checkReviewDownloadAccess } = examHelpers;

    const router = express.Router();

    router.post('/get-result-detail', verifyFirebaseToken, async (req, res) => {
        try {
            const { result_id } = req.body;
            if (!result_id || typeof result_id !== 'string') {
                return res.status(400).json({ message: 'Thiếu result_id.' });
            }

            const resultSnap = await dbAdmin.collection('results').doc(result_id).get();
            if (!resultSnap.exists) {
                return res.status(404).json({ message: 'Không tìm thấy bài làm.' });
            }
            const resultData = resultSnap.data();

            if (resultData.student_id !== req.uid) {
                return res.status(403).json({ message: 'Bạn không có quyền xem bài làm của người khác.' });
            }

            const examSnap = await dbAdmin.collection('exams').doc(resultData.exam_id).get();
            const examData = examSnap.exists ? examSnap.data() : {};

            const scoreVisible = examData.showScoreImmediately === true;
            const questionsVisible = scoreVisible && examData.showCorrectAnswers === true;
            const explanationVisible = questionsVisible && examData.showExplanation === true;

            const fullDetails = Array.isArray(resultData.details) ? resultData.details : [];
            const totalQuestions = Number(resultData.totalQuestions) || fullDetails.length;
            const correctCount = Number(resultData.correctCount) || 0;
            const skippedCount = fullDetails.filter(
                (d) => d.skipped === true || isBlankAnswer(d.studentAnswer)
            ).length;
            const manualCount = Array.isArray(resultData.manualItems) ? resultData.manualItems.length : 0;
            const incorrectCount = Math.max(0, totalQuestions - manualCount - correctCount - skippedCount);

            const responsePayload = {
                ok: true,
                studentName: resultData.studentName || '',
                quizName: resultData.quizName || '',
                className: resultData.className || '',
                subject: resultData.subject || '',
                submitTime: (resultData.submitTime && typeof resultData.submitTime.toDate === 'function')
                    ? resultData.submitTime.toDate().toISOString()
                    : null,
                scoreVisible,
                questionsVisible,
                explanationVisible,
                gradingStatus: resultData.gradingStatus || 'graded',
                // Cờ miễn thi thật do giáo viên đặt (routes/grading.js); client không được tự suy ra từ score === null.
                excused: resultData.excused === true || resultData.status === 'excused'
            };

            if (Array.isArray(resultData.manualItems) && resultData.manualItems.length > 0) {
                responsePayload.manualItems = resultData.manualItems.map((item) => ({
                    type: (item && item.type === 'upload') ? 'upload' : 'essay',
                    questionText: (item && typeof item.questionText === 'string') ? item.questionText : '',
                    essayAnswer: (item && typeof item.essayAnswer === 'string') ? item.essayAnswer : '',
                    fileUrl: (item && typeof item.fileUrl === 'string') ? item.fileUrl : '',
                    fileName: (item && typeof item.fileName === 'string') ? item.fileName : ''
                }));
            }

            if (scoreVisible) {
                responsePayload.score = (resultData.score === undefined) ? null : resultData.score;
                if (typeof resultData.teacherFeedback === 'string' && resultData.teacherFeedback.trim() !== '') {
                    responsePayload.teacherFeedback = resultData.teacherFeedback;
                }
                responsePayload.correctCount = correctCount;
                responsePayload.incorrectCount = incorrectCount;
                responsePayload.skippedCount = skippedCount;
                responsePayload.totalQuestions = totalQuestions;
            }

            if (questionsVisible) {
                const questionIds = fullDetails.map((d) => d.questionId).filter(Boolean);
                const questions = await fetchQuestionsByIds(questionIds);
                const questionMap = {};
                questions.forEach((q) => { questionMap[q.id] = q; });

                responsePayload.questions = fullDetails.map((d) => {
                    const q = questionMap[d.questionId] || {};
                    const canonicalType = resolveDetailType(q, d);
                    const item = {
                        id: d.questionId,
                        type: canonicalType,
                        text: q.question_text || q.question || q.text || '',
                        options: getOptionTextsServer(q),
                        studentAnswer: Array.isArray(d.studentAnswer) ? d.studentAnswer
                            : (typeof d.studentAnswer === 'number' ? d.studentAnswer : null),
                        correctAnswer: Array.isArray(d.correctAnswer) ? d.correctAnswer
                            : (typeof d.correctAnswer === 'number' ? d.correctAnswer : -1),
                        isCorrect: d.isCorrect === true,
                        skipped: d.skipped === true
                    };

                    if (canonicalType === 'fill_blank' && Array.isArray(d.correctAnswer)) {
                        item.blanks = d.correctAnswer.map((b) => ({
                            acceptedAnswers: Array.isArray(b && b.acceptedAnswers) ? b.acceptedAnswers : []
                        }));
                    }

                    if (canonicalType === 'matching' && Array.isArray(d.correctAnswer)) {
                        const studentMap = (d.studentAnswer && typeof d.studentAnswer === 'object' && !Array.isArray(d.studentAnswer))
                            ? d.studentAnswer : {};
                        const pairById = {};
                        d.correctAnswer.forEach((p) => { if (p && p.id !== undefined && p.id !== null) pairById[p.id] = p; });

                        item.pairs = d.correctAnswer.map((p) => {
                            const chosenId = studentMap[p.id];
                            const chosenPair = (chosenId !== undefined && chosenId !== null) ? pairById[chosenId] : null;
                            return {
                                left: p.left,
                                right: p.right,
                                studentRight: chosenPair ? chosenPair.right : '',
                                isCorrect: (chosenId !== undefined && chosenId !== null) ? String(chosenId) === String(p.id) : false
                            };
                        });
                    }

                    if (canonicalType === 'ordering' && Array.isArray(d.correctAnswer)) {
                        const orderingView = buildOrderingResultView(q, d);
                        // Ảnh chụp chữ lúc chấm (d.itemTexts) ưu tiên hơn câu hỏi hiện tại: giáo viên sửa/xoá câu về sau
                        // không được làm lệch bài đã nộp (cùng cách với d.dragTexts của câu Kéo-thả).
                        const snapTexts = (d.itemTexts && typeof d.itemTexts === 'object') ? d.itemTexts : {};
                        item.items = d.correctAnswer.map((id, i) => (
                            typeof snapTexts[id] === 'string' ? snapTexts[id] : orderingView.items[i]
                        ));
                        item.studentPositions = orderingView.studentPositions;
                    }

                    if (canonicalType === 'drag_drop' && Array.isArray(d.correctAnswer)) {
                        const dragDropView = buildDragDropResultView(q, d);
                        item.zones = dragDropView.zones;
                        item.distractors = dragDropView.distractors;
                    }

                    if (explanationVisible) {
                        item.explanation = typeof d.explanation === 'string' ? d.explanation : '';
                    }
                    return item;
                });
            }

            return res.json(responsePayload);
        } catch (error) {
            console.error('Lỗi lấy chi tiết bài làm:', error);
            return res.status(500).json({ message: 'Lỗi server khi tải chi tiết bài làm.' });
        }
    });

    router.post('/get-review-material', verifyFirebaseToken, async (req, res) => {
        try {
            const studentId = req.uid;
            const { exam_id } = req.body || {};

            if (!exam_id || typeof exam_id !== 'string' || exam_id.includes('/')) {
                return res.status(400).json({ message: 'Thiếu hoặc sai exam_id.' });
            }

            const examSnap = await dbAdmin.collection('exams').doc(exam_id).get();
            if (!examSnap.exists) {
                return res.status(404).json({ message: 'Không tìm thấy bài kiểm tra.' });
            }
            const examData = examSnap.data();

            const access = await checkReviewDownloadAccess(exam_id, examData, studentId);
            if (!access.ok) {
                return res.status(access.status).json({ message: access.message });
            }

            const questionIds = Array.isArray(examData.questionIds) ? examData.questionIds : [];
            if (questionIds.length === 0) {
                return res.status(400).json({ message: 'Bài kiểm tra chưa có câu hỏi.' });
            }

            const includeExplanation = examData.showExplanation === true;
            const questions = await fetchQuestionsByIds(questionIds);

            res.set('Cache-Control', 'no-store');
            return res.json({
                ok: true,
                title: examData.quizName || examData.title || 'Bài kiểm tra',
                subject: examData.subject || '',
                includeExplanation,
                questions: questions.map((q) => toReviewQuestionServer(q, includeExplanation))
            });
        } catch (error) {
            console.error('Lỗi lấy dữ liệu file ôn tập:', error);
            return res.status(500).json({ message: 'Lỗi server khi tạo file ôn tập.' });
        }
    });

    return router;
}

module.exports = { createResultRouter };
