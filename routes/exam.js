// Router đề thi: lấy câu hỏi theo mã phòng, theo exam_id và thi thử cho giáo viên (đã xóa đáp án đúng trước khi trả về).

const express = require('express');
const { seededShuffle, sanitizeQuestionForClient } = require('../lib/grading');

function createExamRouter({ dbAdmin, verifyFirebaseToken, examHelpers }) {
    const {
        loadExamForStudent,
        loadExamForStudentByRoomCode,
        fetchQuestionsByIds,
        getOrStartExamSession
    } = examHelpers;

    const router = express.Router();

    router.get('/get-exam-questions', verifyFirebaseToken, async (req, res) => {
        try {
            const studentId = req.uid;
            const roomCode = typeof req.query.code === 'string' ? req.query.code.trim() : '';

            if (!roomCode) {
                return res.status(400).json({ message: 'Thiếu mã phòng thi (code).' });
            }

            const access = await loadExamForStudentByRoomCode(roomCode, studentId);
            if (!access.ok) {
                return res.status(access.status).json({ message: access.message });
            }
            const { examId, examData } = access;

            const maxAttempts = Number(examData.maxAttempts) > 0 ? Number(examData.maxAttempts) : null;
            if (maxAttempts !== null) {
                const attemptSnap = await dbAdmin.collection('exam_attempts').doc(`${examId}_${studentId}`).get();
                const usedAttempts = attemptSnap.exists ? (Number(attemptSnap.data().count) || 0) : 0;

                if (usedAttempts >= maxAttempts) {
                    return res.status(403).json({ message: 'Bạn đã hết số lần làm bài cho phép đối với bài kiểm tra này.' });
                }
            }

            const questionIds = Array.isArray(examData.questionIds) ? examData.questionIds : [];
            if (questionIds.length === 0) {
                return res.status(400).json({ message: 'Bài kiểm tra chưa có câu hỏi.' });
            }

            const startedAtMs = await getOrStartExamSession(examId, studentId, examData);

            let orderedQuestions = await fetchQuestionsByIds(questionIds);

            if (examData.shuffleQuestions === true) {
                orderedQuestions = seededShuffle(orderedQuestions, `${examId}_${studentId}`);
            }

            const sanitizedQuestions = orderedQuestions.map(
                (q) => sanitizeQuestionForClient(q, `${examId}_${studentId}_${q.id}`)
            );

            return res.json({
                examId,
                title: examData.quizName || examData.title || '',
                duration: examData.duration || 15,
                allowSkip: examData.allowSkip !== false,
                allowFlagForReview: examData.allowFlagForReview === true,
                startedAt: startedAtMs,
                questions: sanitizedQuestions
            });
        } catch (error) {
            console.error('Lỗi lấy câu hỏi theo mã phòng:', error);
            return res.status(500).json({ message: 'Lỗi server khi tải câu hỏi.' });
        }
    });

    router.get('/preview-exam', verifyFirebaseToken, async (req, res) => {
        try {
            const examId = typeof req.query.exam_id === 'string' ? req.query.exam_id.trim() : '';
            if (!examId) {
                return res.status(400).json({ message: 'Thiếu exam_id.' });
            }

            const examSnap = await dbAdmin.collection('exams').doc(examId).get();
            if (!examSnap.exists) {
                return res.status(404).json({ message: 'Không tìm thấy bài kiểm tra.' });
            }
            const examData = examSnap.data();

            if (examData.teacher_id !== req.uid) {
                return res.status(403).json({ message: 'Chỉ giáo viên tạo bài kiểm tra này mới được thi thử.' });
            }

            const questionIds = Array.isArray(examData.questionIds) ? examData.questionIds : [];
            if (questionIds.length === 0) {
                return res.status(400).json({ message: 'Bài kiểm tra chưa có câu hỏi.' });
            }

            let orderedQuestions = await fetchQuestionsByIds(questionIds);
            if (examData.shuffleQuestions === true) {
                orderedQuestions = seededShuffle(orderedQuestions, `${examId}_${req.uid}`);
            }

            return res.json({
                examId,
                preview: true,
                title: examData.quizName || examData.title || '',
                subject: examData.subject || '',
                duration: examData.duration || 15,
                allowSkip: examData.allowSkip !== false,
                allowFlagForReview: examData.allowFlagForReview === true,
                questions: orderedQuestions.map((q) => sanitizeQuestionForClient(q, `${examId}_${req.uid}_${q.id}`))
            });
        } catch (error) {
            console.error('Lỗi thi thử bài kiểm tra:', error);
            return res.status(500).json({ message: 'Lỗi server khi tải bài thi thử.' });
        }
    });

    router.post('/get-exam-questions', verifyFirebaseToken, async (req, res) => {
        try {
            const studentId = req.uid;
            const { exam_id } = req.body;

            if (!exam_id || typeof exam_id !== 'string') {
                return res.status(400).json({ message: 'Thiếu exam_id.' });
            }

            const access = await loadExamForStudent(exam_id, studentId);
            if (!access.ok) {
                return res.status(access.status).json({ message: access.message });
            }
            const examData = access.examData;

            const questionIds = Array.isArray(examData.questionIds) ? examData.questionIds : [];
            if (questionIds.length === 0) {
                return res.status(400).json({ message: 'Bài kiểm tra chưa có câu hỏi.' });
            }

            const orderedQuestions = await fetchQuestionsByIds(questionIds);

            const sanitizedQuestions = orderedQuestions.map(
                (q) => sanitizeQuestionForClient(q, `${exam_id}_${studentId}_${q.id}`)
            );

            return res.json({ questions: sanitizedQuestions });
        } catch (error) {
            console.error('Lỗi lấy câu hỏi cho học sinh:', error);
            return res.status(500).json({ message: 'Lỗi server khi tải câu hỏi.' });
        }
    });

    return router;
}

module.exports = { createExamRouter };
