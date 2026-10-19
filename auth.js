// Login helpers shared by every page. Needs config.js loaded first.
const AUTH_KEY = "coil-scanner-auth";
const COGNITO_URL = "https://cognito-idp." + COGNITO_REGION + ".amazonaws.com/";
const PAGES = ["index.html", "discharge.html", "loadout.html"];

async function cognitoCall(target, body) {
  const res = await fetch(COGNITO_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "AWSCognitoIdentityProviderService." + target,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    const code = (data.__type || "").split("#").pop();
    const err = new Error(friendlyAuthError(code, data.message));
    err.code = code;
    throw err;
  }
  return data;
}

function friendlyAuthError(code, message) {
  if (code === "NotAuthorizedException" || code === "UserNotFoundException") return "Wrong username or password.";
  if (code === "InvalidPasswordException") return message || "That password doesn't meet the rules.";
  if (code === "TooManyRequestsException" || code === "LimitExceededException") return "Too many tries. Wait a minute and try again.";
  return message || "Login failed.";
}

function readAuth() {
  try { return JSON.parse(localStorage.getItem(AUTH_KEY) || "null"); } catch (e) { return null; }
}
function writeAuth(auth) {
  try { localStorage.setItem(AUTH_KEY, JSON.stringify(auth)); } catch (e) {}
}
function clearAuth() {
  try { localStorage.removeItem(AUTH_KEY); } catch (e) {}
}

function storeResult(username, result, oldRefreshToken) {
  writeAuth({
    username,
    accessToken: result.AccessToken,
    refreshToken: result.RefreshToken || oldRefreshToken,
    expiresAt: Date.now() + (result.ExpiresIn - 60) * 1000,
  });
}

// Returns { done: true } or { challenge: "NEW_PASSWORD_REQUIRED", session }
async function login(username, password) {
  const data = await cognitoCall("InitiateAuth", {
    AuthFlow: "USER_PASSWORD_AUTH",
    ClientId: COGNITO_CLIENT_ID,
    AuthParameters: { USERNAME: username, PASSWORD: password },
  });
  if (data.ChallengeName === "NEW_PASSWORD_REQUIRED") {
    return { challenge: data.ChallengeName, session: data.Session };
  }
  if (!data.AuthenticationResult) throw new Error("Login needs a step this app doesn't support yet.");
  storeResult(username, data.AuthenticationResult);
  return { done: true };
}

async function setNewPassword(username, session, newPassword) {
  const data = await cognitoCall("RespondToAuthChallenge", {
    ChallengeName: "NEW_PASSWORD_REQUIRED",
    ClientId: COGNITO_CLIENT_ID,
    Session: session,
    ChallengeResponses: { USERNAME: username, NEW_PASSWORD: newPassword },
  });
  storeResult(username, data.AuthenticationResult);
}

// Gives a valid access token, renewing it quietly when it expires.
async function getAccessToken() {
  const auth = readAuth();
  if (!auth || !auth.refreshToken) return null;
  if (auth.accessToken && Date.now() < auth.expiresAt) return auth.accessToken;
  try {
    const data = await cognitoCall("InitiateAuth", {
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: COGNITO_CLIENT_ID,
      AuthParameters: { REFRESH_TOKEN: auth.refreshToken },
    });
    storeResult(auth.username, data.AuthenticationResult, auth.refreshToken);
    return readAuth().accessToken;
  } catch (err) {
    if (err.code === "NotAuthorizedException") { clearAuth(); return null; } // login expired or removed
    throw err; // bad signal: keep them logged in and let the page show the error
  }
}

function goToLogin() {
  const page = location.pathname.split("/").pop() || "index.html";
  location.href = "login.html?next=" + encodeURIComponent(page);
}

function requireLogin() {
  if (!readAuth()) goToLogin();
}

// Use this instead of fetch() for calls to the Lambda.
async function authFetch(url, options = {}) {
  const token = await getAccessToken();
  if (!token) { goToLogin(); throw new Error("Please log in"); }
  const headers = Object.assign({}, options.headers || {}, { Authorization: "Bearer " + token });
  const res = await fetch(url, Object.assign({}, options, { headers }));
  if (res.status === 401) { clearAuth(); goToLogin(); throw new Error("Please log in again"); }
  return res;
}

function currentUser() {
  const auth = readAuth();
  return auth ? auth.username : null;
}

function logout() {
  clearAuth();
  location.href = "login.html";
}

function safeNextPage() {
  const next = new URLSearchParams(location.search).get("next");
  return PAGES.includes(next) ? next : "index.html";
}