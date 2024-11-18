import express from 'express';
import routes from './routes/routes.js';
import cors from "cors";
import herokuSSLRedirect from "heroku-ssl-redirect";
import helmet from "helmet";
import cookieParser from 'cookie-parser';

const sslRedirect = herokuSSLRedirect.default;
const app = express();
const PORT = process.env.PORT || 3000;

app.use(sslRedirect());
app.use(cors());
app.use(helmet());
app.use(express.json());
app.use(cookieParser());
app.use(routes);

app.listen(PORT, function (err) {
  if (err) console.log(err);
  console.log("Server listening on PORT", PORT);
});
