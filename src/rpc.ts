import * as admin from './services/admin';
import { migrate } from './services/supabase-auth';
import * as auth from './services/auth';
import type { Ctx } from './services/common';
import * as posts from './services/posts';
import * as social from './services/social';

// 클라이언트가 부를 수 있는 기능 목록(이 이름 목록에 있는 것만 실행돼요).
// 각 기능은 스스로 로그인·운영자 권한을 검사해요.
export type Handler = (ctx: Ctx, ...args: unknown[]) => Promise<unknown>;

export const handlers: Record<string, Handler> = {
  'auth.requestEmailCode': auth.requestEmailCode,
  'auth.verifyEmailCode': auth.verifySignupEmailCode,
  'auth.provisionSignup': auth.provisionSignup,
  'auth.signup': auth.completeSupabaseSignup,
  'auth.migrate': migrate,
  'auth.me': auth.me,
  'auth.updateAvatar': auth.updateAvatar,
  'auth.changeNickname': auth.changeNickname,
  'auth.withdraw': auth.withdraw,

  'post.list': posts.list,
  'post.search': posts.search,
  'post.mine': posts.mine,
  'post.subscribed': posts.subscribedFeed,
  'post.get': posts.get,
  'post.create': posts.create,
  'post.update': posts.update,
  'post.toggleLike': posts.toggleLike,
  'post.setPrivate': posts.setPrivate,
  'post.remove': posts.remove,
  'post.setPinned': posts.setPinned,

  'comment.list': posts.listComments,
  'comment.add': posts.addComment,

  'social.subscribe': social.subscribe,
  'social.block': social.block,
  'social.unblock': social.unblock,
  'social.blockedUsers': social.blockedUsers,

  'leaf.logs': social.leafLogs,
  'note.today': social.noteToday,
  'note.save': social.saveNote,
  'notification.list': social.notificationList,
  'notification.markAllRead': social.notificationsMarkAllRead,
  'notification.clear': social.notificationsClear,
  'report.create': social.createReport,

  'admin.reports': admin.reports,
  'admin.reportHistory': admin.reportHistory,
  'admin.alerts': admin.alerts,
  'admin.setReportStatus': admin.setReportStatus,
  'admin.resolveReport': admin.resolveReport,
  'admin.liftRestriction': admin.liftRestriction,
  'admin.setAlertStatus': admin.setAlertStatus,
  'admin.sendCareNotice': admin.sendCareNotice,
  'admin.identityForAlert': admin.identityForAlert,
  'admin.listMembers': admin.listMembers,
  'admin.viewIdentity': admin.viewIdentity,
  'admin.identityLogs': admin.identityLogs,
  'admin.createAdmin': admin.createAdmin,
  'admin.listAdmins': admin.listAdmins,
  'admin.removeAdmin': admin.removeAdmin,
  'admin.blockedEmails': admin.blockedEmails,
  'admin.unblockEmail': admin.unblockEmail,
};
