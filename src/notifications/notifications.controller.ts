import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../auth/current-user.decorator';
import { DeletePushTokenDto, RegisterPushTokenDto } from './dto/push-token.dto';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Post('tokens')
  @HttpCode(HttpStatus.OK)
  async registerToken(
    @Body() dto: RegisterPushTokenDto,
    @CurrentUserId() userId: string,
  ): Promise<{ success: true }> {
    await this.notificationsService.registerToken(
      userId,
      dto.token,
      dto.platform,
    );
    return { success: true };
  }

  @Delete('tokens')
  @HttpCode(HttpStatus.OK)
  async deleteToken(
    @Body() dto: DeletePushTokenDto,
    @CurrentUserId() userId: string,
  ): Promise<{ success: true }> {
    await this.notificationsService.deleteToken(userId, dto.token);
    return { success: true };
  }
}
