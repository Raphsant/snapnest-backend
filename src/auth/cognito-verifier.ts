import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { CognitoIdTokenPayload } from 'aws-jwt-verify/jwt-model';

let verifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;

function getVerifier(): ReturnType<typeof CognitoJwtVerifier.create> {
  if (verifier === null) {
    const userPoolId = process.env.COGNITO_USER_POOL_ID;
    const clientId = process.env.COGNITO_CLIENT_ID;
    if (!userPoolId?.trim() || !clientId?.trim()) {
      throw new Error(
        'Cognito verifier misconfigured: COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID must be set',
      );
    }
    verifier = CognitoJwtVerifier.create({
      userPoolId: userPoolId.trim(),
      clientId: clientId.trim(),
      tokenUse: 'id',
    });
  }
  return verifier;
}

export async function verifyToken(
  token: string,
): Promise<CognitoIdTokenPayload> {
  const payload = await getVerifier().verify(token);
  return payload as CognitoIdTokenPayload;
}
