// Payment link handler — serves pay.carsoncars.net/:stockNbr
// Logs click then 302 redirects to eAutoPayment

function addPayRoutes(app, db) {
  app.get('/:stockNbr', (req, res) => {
    const host = req.hostname || req.headers.host || '';
    if (!host.includes('pay.carsoncars.net')) {
      return res.status(404).send('Not found');
    }
    
    const stockNbr = req.params.stockNbr;
    if (!stockNbr || stockNbr === 'health' || stockNbr === 'favicon.ico') {
      return res.status(404).send('Not found');
    }
    
    // Log click
    try {
      const logClick = db.prepare(`
        INSERT INTO click_log (account_number, clicked_at, ip_address, user_agent, referrer)
        VALUES (?, datetime('now'), ?, ?, ?)
      `);
      logClick.run(stockNbr, req.ip, req.get('user-agent') || '', req.get('referer') || '');
      console.log(`[Pay] Click logged: Stk#${stockNbr} from ${req.ip}`);
    } catch(e) {
      console.error('[Pay] Click log error:', e.message);
    }
    
    // 302 redirect to eAutoPayment
    res.redirect(302, 'https://www.eautopayment.com/Registration?merchantAccountId=1503-2413-1611');
  });
}

module.exports = { addPayRoutes };
