import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Body for POST /notifications/tokens.
 *
 * `token` is an Expo push token. Format is validated for real at send time via
 * `Expo.isExpoPushToken` (the SDK is the source of truth), so here we only
 * enforce a non-empty, length-bounded string to reject obvious garbage.
 *
 * `platform` is a free string on the column; Phase A only ever sends "ios".
 */
export class RegisterPushTokenDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  token!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  platform!: string;
}

/**
 * Body for DELETE /notifications/tokens (idempotent logout).
 */
export class DeletePushTokenDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  token!: string;
}
