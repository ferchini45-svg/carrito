const express = require('express');
const mysql = require('mysql2');
const session = require('express-session');
const bcrypt = require('bcrypt');
const path = require('path');
const PDFDocument = require('pdfkit');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json()); // Añadí esto para manejar JSON
app.set('view engine', 'ejs');

// Sesiones
app.use(session({
    secret: process.env.SESSION_SECRET || 'tu_secreto_aqui_123',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 } // 1 día
}));

// ---------------- CONEXIÓN MySQL ----------------
const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    connectionLimit: 10
});

// Middleware para exponer user en vistas
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    next();
});

// ------------------ RUTAS ------------------

// Home -> lista productos
app.get('/', (req, res) => {
    db.query('SELECT * FROM productos', (err, productos) => {
        if (err) return res.send('Error BD');
        res.render('productos', { productos });
    });
});

// Mostrar productos (alias)
app.get('/productos', (req, res) => {
    db.query('SELECT * FROM productos', (err, productos) => {
        if (err) return res.send('Error BD');
        res.render('productos', { productos });
    });
});

// Registrar
app.get('/register', (req, res) => res.render('register'));
app.post('/register', async (req, res) => {
    const { nombre, correo, password } = req.body;
    if (!nombre || !correo || !password) return res.send('Rellena todos los campos');

    // verificar si existe
    db.query('SELECT id FROM usuarios WHERE correo=?', [correo], async (err, rows) => {
        if (err) return res.send('Error BD');
        if (rows.length > 0) return res.send('Correo ya registrado');
        const hash = await bcrypt.hash(password, 10);
        db.query('INSERT INTO usuarios (nombre, correo, password) VALUES (?, ?, ?)', [nombre, correo, hash], (err2) => {
            if (err2) return res.send('Error al registrar');
            res.redirect('/login');
        });
    });
});

// Login
app.get('/login', (req, res) => res.render('login'));
app.post('/login', (req, res) => {
    const { correo, password } = req.body;
    if (!correo || !password) return res.send('Rellena los campos');

    db.query('SELECT * FROM usuarios WHERE correo=?', [correo], async (err, rows) => {
        if (err) return res.send('Error BD');
        if (rows.length === 0) return res.send('Usuario no encontrado');
        const user = rows[0];
        const ok = await bcrypt.compare(password, user.password);
        if (!ok) return res.send('Contraseña incorrecta');
        // guardar en sesión
        req.session.user = { id: user.id, nombre: user.nombre, correo: user.correo };
        if (!req.session.cart) req.session.cart = {};
        res.redirect('/');
    });
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});

// ---------------- CART (en sesión) ----------------

// Añadir al carrito (POST desde formulario o fetch)
app.post('/cart/add', (req, res) => {
    const { producto_id, cantidad } = req.body;
    const pid = parseInt(producto_id);
    const qty = Math.max(1, parseInt(cantidad) || 1);

    if (!req.session.cart) req.session.cart = {};

    // si ya existe incrementar
    if (req.session.cart[pid]) {
        req.session.cart[pid].cantidad += qty;
        return res.json({ ok: true, cart: req.session.cart });
    } else {
        // ahora sí, traer también la imagen
        db.query('SELECT id, nombre, precio, imagen FROM productos WHERE id = ?', [pid], (err, rows) => {
            if (err || rows.length === 0) {
                return res.json({ ok: false });
            }

            const p = rows[0];

            req.session.cart[pid] = {
                producto_id: p.id,
                nombre: p.nombre,
                precio: parseFloat(p.precio),
                cantidad: qty,
                imagen: p.imagen   // ← AGREGADO
            };

            return res.json({ ok: true, cart: req.session.cart });
        });
    }
});

// Obtener carrito (para render o fetch)
app.get('/cart', (req, res) => {
    const cart = req.session.cart || {};
    // calcular total
    let total = 0;
    for (let k in cart) {
        total += cart[k].precio * cart[k].cantidad;
    }
    res.render('carrito', { cart, total });
});

app.post('/cart/update', (req, res) => {
    const { producto_id, cantidad } = req.body;
    const pid = parseInt(producto_id);
    const qty = parseInt(cantidad);

    if (!req.session.cart || !req.session.cart[pid]) {
        return res.json({ ok: false });
    }

    if (qty <= 0) {
        delete req.session.cart[pid];
    } else {
        req.session.cart[pid].cantidad = qty;
    }

    let total = 0;
    Object.values(req.session.cart).forEach(it => {
        total += it.precio * it.cantidad;
    });

    return res.json({
        ok: true,
        cart: req.session.cart,
        total
    });
});

// Quitar producto
app.post('/cart/remove', (req, res) => {
    const pid = parseInt(req.body.producto_id);
    if (req.session.cart && req.session.cart[pid]) {
        delete req.session.cart[pid];
    }
    let total = 0;
    if (req.session.cart) {
        for (let k in req.session.cart) total += req.session.cart[k].precio * req.session.cart[k].cantidad;
    }
    res.json({ ok: true, total, cart: req.session.cart });
});

// ---------------- CHECKOUT y HISTORIAL ----------------

// Ver historial (usuario debe estar logeado)
app.get('/historial', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const uid = req.session.user.id;

    db.query('SELECT * FROM pedidos WHERE usuario_id=? ORDER BY fecha DESC', [uid], (err, pedidos) => {
        if (err) return res.send('Error BD');
        // por cada pedido sacar items
        const pedidosIds = pedidos.map(p => p.id);
        if (pedidosIds.length === 0) return res.render('historial', { pedidos: [] });

        db.query('SELECT pi.*, pr.nombre FROM pedido_items pi JOIN productos pr ON pr.id = pi.producto_id WHERE pi.pedido_id IN (?)', [pedidosIds], (err2, items) => {
            if (err2) return res.send('Error BD');
            // agrupar items por pedido
            const mapa = {};
            items.forEach(it => {
                if (!mapa[it.pedido_id]) mapa[it.pedido_id] = [];
                mapa[it.pedido_id].push(it);
            });
            // unir
            pedidos.forEach(p => p.items = mapa[p.id] || []);
            res.render('historial', { pedidos });
        });
    });
});

// Checkout (crear pedido) — requiere login
app.post('/checkout', (req, res) => {
    if (!req.session.user) return res.json({ ok: false, msg: 'Debe iniciar sesión' });
    const cart = req.session.cart || {};
    const items = Object.values(cart);
    if (items.length === 0) return res.json({ ok: false, msg: 'Carrito vacío' });

    const total = items.reduce((s, it) => s + it.precio * it.cantidad, 0);

    // insertar pedido
    db.query('INSERT INTO pedidos (usuario_id, total) VALUES (?, ?)', [req.session.user.id, total], (err, result) => {
        if (err) return res.json({ ok: false, msg: 'Error al crear pedido' });
        const pedidoId = result.insertId;

        // insertar items
        const values = items.map(it => [pedidoId, it.producto_id, it.cantidad, it.precio]);
        db.query('INSERT INTO pedido_items (pedido_id, producto_id, cantidad, precio_unit) VALUES ?', [values], (err2) => {
            if (err2) return res.json({ ok: false, msg: 'Error al guardar items' });

            // limpiar carrito de sesión
            req.session.cart = {};

            // responder con id de pedido y redirección para descargar PDF
            return res.json({ 
                ok: true, 
                pedidoId,
                redirect: `/pedido/${pedidoId}/ticket` // Para redirigir automáticamente
            });
        });
    });
});

// Generar ticket PDF (ruta que descarga o muestra PDF)
app.get('/pedido/:id/ticket', (req, res) => {
    const pedidoId = req.params.id;
    
    // Verificar si el usuario está logueado
    if (!req.session.user) {
        return res.redirect('/login');
    }
    
    // buscar pedido e items con verificación de usuario
    db.query('SELECT p.*, u.nombre, u.correo FROM pedidos p JOIN usuarios u ON u.id = p.usuario_id WHERE p.id=? AND p.usuario_id=?', [pedidoId, req.session.user.id], (err, pedidos) => {
        if (err || pedidos.length === 0) return res.send('Pedido no encontrado o no tienes permisos');
        
        const pedido = pedidos[0];
        db.query('SELECT pi.*, pr.nombre FROM pedido_items pi JOIN productos pr ON pr.id = pi.producto_id WHERE pi.pedido_id=?', [pedidoId], (err2, items) => {
            if (err2) return res.send('Error al obtener items');

            const doc = new PDFDocument({ margin: 40 });

            res.setHeader('Content-disposition', `attachment; filename=ticket_pedido_${pedidoId}.pdf`);
            res.setHeader('Content-type', 'application/pdf');

            // Encabezado
            doc.fontSize(18).text('Ticket de compra', { align: 'center' });
            doc.moveDown();
            doc.fontSize(12).text(`Pedido: ${pedido.id}`);
            doc.text(`Usuario: ${pedido.nombre} - ${pedido.correo}`);
            doc.text(`Fecha: ${new Date(pedido.fecha).toLocaleString()}`);
            doc.moveDown();

            // Encabezado tabla
            const tableTop = doc.y + 20;
            doc.font('Helvetica-Bold');
            doc.text('Producto', 50, tableTop);
            doc.text('Cant.', 300, tableTop);
            doc.text('Precio unit', 380, tableTop);
            doc.text('Subtotal', 480, tableTop);

            // Contenido tabla
            doc.font('Helvetica');

            let y = tableTop + 20;
            let total = 0;

            items.forEach(i => {
                const precio = Number(i.precio_unit) || 0;
                const subtotal = precio * Number(i.cantidad);

                doc.text(i.nombre, 50, y);
                doc.text(String(i.cantidad), 300, y);
                doc.text(precio.toFixed(2), 380, y);
                doc.text(subtotal.toFixed(2), 480, y);

                total += subtotal;
                y += 20;
            });

            // Total final
            doc.moveDown();
            doc.font('Helvetica-Bold').text(`Total: $${total.toFixed(2)}`, { align: 'right' });

            // Finalizar PDF - CORREGIDO: Pipe debe ir antes
            doc.pipe(res);
            doc.end();
        });
    });
});

// ---------------- INICIAR SERVIDOR ----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
