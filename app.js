
const express = require('express');
const mysql = require('mysql2');
const session = require('express-session');
const bcrypt = require('bcrypt');
const path = require('path');
const PDFDocument = require('pdfkit');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.set('view engine', 'ejs');

// Sesiones (para producción conviene usar store en MySQL o Redis)
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

db.getConnection((err, conn) => {
if (err) console.error('Error al conectar a la BD:', err);
else {
console.log('Conexión a la BD correcta');
conn.release();
}
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
if (err) {
console.error(err);
return res.send('Error BD');
}
res.render('productos', { productos });
});
});

// Registrar
app.get('/register', (req, res) => res.render('register'));
app.post('/register', async (req, res) => {
const { nombre, correo, password } = req.body;
if (!nombre || !correo || !password) return res.send('Rellena todos los campos');

```
db.query('SELECT id FROM usuarios WHERE correo=?', [correo], async (err, rows) => {
    if (err) return res.send('Error BD');
    if (rows.length > 0) return res.send('Correo ya registrado');
    const hash = await bcrypt.hash(password, 10);
    db.query('INSERT INTO usuarios (nombre, correo, password) VALUES (?, ?, ?)', [nombre, correo, hash], (err2) => {
        if (err2) return res.send('Error al registrar');
        res.redirect('/login');
    });
});
```

});

// Login
app.get('/login', (req, res) => res.render('login'));
app.post('/login', (req, res) => {
const { correo, password } = req.body;
if (!correo || !password) return res.send('Rellena los campos');

```
db.query('SELECT * FROM usuarios WHERE correo=?', [correo], async (err, rows) => {
    if (err) return res.send('Error BD');
    if (rows.length === 0) return res.send('Usuario no encontrado');
    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.send('Contraseña incorrecta');
    req.session.user = { id: user.id, nombre: user.nombre, correo: user.correo };
    if (!req.session.cart) req.session.cart = {};
    console.log('Usuario logeado:', req.session.user); // debug
    res.redirect('/');
});
```

});

app.get('/logout', (req, res) => {
req.session.destroy(() => res.redirect('/'));
});

// ---------------- CART ----------------
app.post('/cart/add', (req, res) => {
const { producto_id, cantidad } = req.body;
const pid = parseInt(producto_id);
const qty = Math.max(1, parseInt(cantidad) || 1);

```
if (!req.session.cart) req.session.cart = {};

db.query('SELECT id, nombre, precio, imagen FROM productos WHERE id=?', [pid], (err, rows) => {
    if (err || rows.length === 0) return res.json({ ok: false });
    const p = rows[0];
    if (req.session.cart[pid]) req.session.cart[pid].cantidad += qty;
    else req.session.cart[pid] = { producto_id: p.id, nombre: p.nombre, precio: parseFloat(p.precio), cantidad: qty, imagen: p.imagen };

    console.log('Carrito actualizado:', req.session.cart);
    res.json({ ok: true, cart: req.session.cart });
});
```

});

app.get('/cart', (req, res) => {
const cart = req.session.cart || {};
let total = 0;
Object.values(cart).forEach(it => total += it.precio * it.cantidad);
res.render('carrito', { cart, total });
});

app.post('/cart/update', (req, res) => {
const { producto_id, cantidad } = req.body;
const pid = parseInt(producto_id);
const qty = parseInt(cantidad);

```
if (!req.session.cart || !req.session.cart[pid]) return res.json({ ok: false });

if (qty <= 0) delete req.session.cart[pid];
else req.session.cart[pid].cantidad = qty;

let total = 0;
Object.values(req.session.cart).forEach(it => total += it.precio * it.cantidad);
res.json({ ok: true, cart: req.session.cart, total });
```

});

app.post('/cart/remove', (req, res) => {
const pid = parseInt(req.body.producto_id);
if (req.session.cart && req.session.cart[pid]) delete req.session.cart[pid];
let total = 0;
if (req.session.cart) Object.values(req.session.cart).forEach(it => total += it.precio * it.cantidad);
res.json({ ok: true, cart: req.session.cart, total });
});

// ---------------- CHECKOUT ----------------
app.post('/checkout', (req, res) => {
if (!req.session.user) return res.json({ ok: false, msg: 'Debe iniciar sesión' });
const cart = req.session.cart || {};
const items = Object.values(cart);
if (items.length === 0) return res.json({ ok: false, msg: 'Carrito vacío' });

```
const total = items.reduce((s, it) => s + it.precio * it.cantidad, 0);

db.query('INSERT INTO pedidos (usuario_id, total) VALUES (?, ?)', [req.session.user.id, total], (err, result) => {
    if (err) return res.json({ ok: false, msg: 'Error al crear pedido' });
    const pedidoId = result.insertId;
    const values = items.map(it => [pedidoId, it.producto_id, it.cantidad, it.precio]);

    if (values.length > 0) {
        const sql = 'INSERT INTO pedido_items (pedido_id, producto_id, cantidad, precio_unit) VALUES ?';
        db.query(sql, [values], (err2) => {
            if (err2) return res.json({ ok: false, msg: 'Error al guardar items' });
            req.session.cart = {};
            res.json({ ok: true, pedidoId });
        });
    } else {
        req.session.cart = {};
        res.json({ ok: true, pedidoId });
    }
});
```

});

// ---------------- INICIAR SERVIDOR ----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));







