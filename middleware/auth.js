// Middleware xác thực: kiểm tra token Firebase và quyền giáo viên/admin của request.

function createAuthMiddleware({ authAdmin, dbAdmin }) {
    async function verifyFirebaseToken(req, res, next) {
        const authHeader = req.headers.authorization || '';
        const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

        if (!idToken) {
            return res.status(401).json({ message: 'Thiếu token xác thực. Vui lòng đăng nhập lại.' });
        }

        try {
            const decoded = await authAdmin.verifyIdToken(idToken);
            req.uid = decoded.uid;
            next();
        } catch (err) {
            console.error('Token không hợp lệ hoặc đã hết hạn:', err.message);
            return res.status(401).json({ message: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.' });
        }
    }

    async function requireTeacherRole(req, res, next) {
        const authHeader = req.headers.authorization || '';
        const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

        if (!idToken) {
            return res.status(401).json({ message: 'Thiếu token xác thực. Vui lòng đăng nhập lại.' });
        }

        try {
            const decoded = await authAdmin.verifyIdToken(idToken);
            req.uid = decoded.uid;

            const userSnap = await dbAdmin.collection('users').doc(decoded.uid).get();
            const role = userSnap.exists ? userSnap.data().role : null;

            if (role !== 'giaovien' && role !== 'admin') {
                return res.status(403).json({ message: 'Chỉ tài khoản giáo viên hoặc admin mới được dùng tính năng này.' });
            }

            next();
        } catch (err) {
            console.error('Xác thực/kiểm tra quyền giáo viên thất bại:', err.message);
            return res.status(401).json({ message: 'Phiên đăng nhập đã hết hạn hoặc không hợp lệ. Vui lòng đăng nhập lại.' });
        }
    }

    return { verifyFirebaseToken, requireTeacherRole };
}

function getBearerToken(req) {
    const header = String((req.headers && (req.headers.authorization || req.headers.Authorization)) || '');
    const match = /^Bearer\s+(.+)$/i.exec(header);
    return match ? match[1].trim() : '';
}

module.exports = { createAuthMiddleware, getBearerToken };
