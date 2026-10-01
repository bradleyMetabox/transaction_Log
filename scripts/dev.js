// Local server: npm run dev  (reads .env)
import app from '../src/http.js';

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`MRA chain service on http://localhost:${port}`);
});
