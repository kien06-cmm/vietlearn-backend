// Router nộp bài: kiểm tra phiên và thời gian, chấm điểm tự động trên server, lưu kết quả và trả dữ liệu theo cờ hiển thị.

const express = require('express');
const {
    gradeSubmission,
    normalizeQuestionType,
    translateMatchingAnswer
} = require('../lib/grading');

function createSubmitRouter({ dbAdmin, FieldValue, verifyFirebaseToken, examHelpers }) {
    const {
        archivePreviousResultAttempt,
        loadExamForStudent,
        loadClassNameById,
        fetchQuestionsByIds,
        checkReviewDownloadAccess
    } = examHelpers;

    const router = express.Router();

    router.post('/submit-exam', verifyFirebaseToken, async (req, res) => {
        try {
            const studentId = req.uid;
            const {
                exam_id, answers, timeUsed, cheatWarnings, cheatLogs,
                studentName: clientStudentName,
                className,
                quizName: clientQuizName,
                subject: clientSubject
            } = req.body;

            if (!exam_id || typeof exam_id !== 'string') {
                return res.status(400).json({ message: 'Thiếu exam_id.' });
            }
            const safeAnswers = (answers && typeof answers === 'object' && !Array.isArray(answers)) ? answers : {};

            const access = await loadExamForStudent(exam_id, studentId);
            if (!access.ok) {
                return res.status(access.status).json({ message: access.message });
            }
            const examData = access.examData;

            const questionIds = Array.isArray(examData.questionIds) ? examData.questionIds : [];
            if (questionIds.length === 0) {
                return res.status(400).json({ message: 'Bài kiểm tra chưa có câu hỏi.' });
            }

            const sessionSnap = await dbAdmin.collection('exam_sessions').doc(`${exam_id}_${studentId}`).get();
            if (!sessionSnap.exists || typeof sessionSnap.data().startedAtMs !== 'number') {
                return res.status(400).json({
                    message: 'Không tìm thấy phiên làm bài hợp lệ. Vui lòng vào lại phòng thi từ đầu.'
                });
            }
            const sessionData = sessionSnap.data();
            const startedAtMs = sessionData.startedAtMs;
            const serverElapsedSeconds = Math.max(0, Math.round((Date.now() - startedAtMs) / 1000));

            const isUnlimitedTime = examData.unlimitedTime === true;
            const allowedDurationSeconds = (Number(examData.duration) > 0 ? Number(examData.duration) : 15) * 60;
            const TOLERANCE_SECONDS = 120;
            const isLateSubmission = !isUnlimitedTime && serverElapsedSeconds > (allowedDurationSeconds + TOLERANCE_SECONDS);

            if (isLateSubmission) {
                console.warn(`Nộp bài trễ hơn dung sai cho phép: exam=${exam_id}, student=${studentId}, serverElapsedSeconds=${serverElapsedSeconds}, allowedDurationSeconds=${allowedDurationSeconds}`);
            }

            const questions = await fetchQuestionsByIds(questionIds);

            const translatedAnswers = { ...safeAnswers };
            questions.forEach((q) => {
                if (normalizeQuestionType(q.type) === 'matching') {
                    translatedAnswers[q.id] = translateMatchingAnswer(
                        q, safeAnswers[q.id], `${exam_id}_${studentId}_${q.id}`
                    );
                }
            });

            const {
                correctCount,
                skippedCount,
                incorrectCount,
                details,
                manualItems,
                totalQuestions,
                hasManualItems,
                gradingStatus,
                autoScore,
                score
            } = gradeSubmission(questions, translatedAnswers);

            let studentName = 'Học sinh';
            try {
                const userSnap = await dbAdmin.collection('users').doc(studentId).get();
                if (userSnap.exists) {
                    const u = userSnap.data();
                    studentName = u.fullname || u.displayName || studentName;
                }
            } catch (nameErr) {
                console.error('Không lấy được tên học sinh (không chặn việc chấm điểm):', nameErr.message);
            }
            if (studentName === 'Học sinh' && typeof clientStudentName === 'string' && clientStudentName.trim()) {
                studentName = clientStudentName.trim();
            }

            const serverClassName = await loadClassNameById(examData.class_id);

            const payload = {
                teacher_id: examData.teacher_id || '',
                exam_id,
                student_id: studentId,
                studentName,
                class_id: examData.class_id || '',
                gradebookColumnId: examData.gradebookColumnId || '',
                gradebookColumnName: examData.gradebookColumnName || '',
                status: hasManualItems ? 'pending_grading' : 'submitted',
                className: serverClassName
                    || ((typeof className === 'string' && className.trim()) ? className.trim() : 'Không xác định'),
                subject: examData.subject || (typeof clientSubject === 'string' ? clientSubject : ''),
                quizName: examData.quizName || examData.title || (typeof clientQuizName === 'string' ? clientQuizName : ''),
                score,
                gradingStatus,
                autoScore: hasManualItems ? autoScore : null,
                manualItems,
                teacherFeedback: '',
                correctCount,
                totalQuestions,
                answers: safeAnswers,
                details,
                cheatWarnings: Number(cheatWarnings) || 0,
                cheatLogs: Array.isArray(cheatLogs) ? cheatLogs : [],
                timeUsedSeconds: serverElapsedSeconds,
                clientReportedTimeUsedSeconds: Number(timeUsed) || 0,
                lateSubmission: isLateSubmission,
                submitTime: FieldValue.serverTimestamp()
            };

            const resultRef = dbAdmin.collection('results').doc(`${exam_id}_${studentId}`);
            await archivePreviousResultAttempt(resultRef);
            await resultRef.set(payload);

            await dbAdmin.collection('exam_sessions').doc(`${exam_id}_${studentId}`).delete().catch((cleanupErr) => {
                console.error('Không xoá được exam_sessions sau khi nộp bài (không chặn kết quả đã lưu):', cleanupErr.message);
            });

            await dbAdmin.collection('exam_attempts').doc(`${exam_id}_${studentId}`).set({
                examId: exam_id,
                studentId,
                count: FieldValue.increment(1),
                lastSubmittedAt: FieldValue.serverTimestamp()
            }, { merge: true });

            const responsePayload = { ok: true, gradingStatus };

            if (examData.showScoreImmediately === true) {
                responsePayload.score = score;
                responsePayload.correctCount = correctCount;
                responsePayload.skippedCount = skippedCount;
                responsePayload.incorrectCount = incorrectCount;
                responsePayload.totalQuestions = totalQuestions;
            }

            if (examData.showCorrectAnswers === true || examData.showExplanation === true) {
                responsePayload.details = details.map((item) => {
                    const filtered = {
                        questionId: item.questionId,
                        studentAnswer: item.studentAnswer,
                        isCorrect: item.isCorrect,
                        skipped: item.skipped === true || item.studentAnswer === null || item.studentAnswer === undefined
                    };
                    if (examData.showCorrectAnswers === true) {
                        filtered.correctAnswer = item.correctAnswer;
                    }
                    if (examData.showExplanation === true) {
                        filtered.explanation = item.explanation;
                    }
                    return filtered;
                });
            }

            try {
                const reviewAccess = await checkReviewDownloadAccess(exam_id, examData, studentId);
                responsePayload.allowDownloadReview = reviewAccess.ok;
                if (!reviewAccess.ok && reviewAccess.locked) {
                    responsePayload.downloadReviewNote = reviewAccess.message;
                }
            } catch (reviewErr) {
                console.error('Không kiểm tra được quyền tải file ôn tập (không chặn việc nộp bài):', reviewErr.message);
                responsePayload.allowDownloadReview = false;
            }

            return res.json(responsePayload);
        } catch (error) {
            console.error('Lỗi chấm điểm / nộp bài:', error);
            return res.status(500).json({ message: 'Lỗi server khi nộp bài. Vui lòng thử lại.' });
        }
    });

    return router;
}

module.exports = { createSubmitRouter };
