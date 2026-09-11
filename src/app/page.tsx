import { auth } from '@clerk/nextjs/server';
import MailerApp from './MailerApp';

export default async function Page() {
  await auth.protect(); // brak sesji → redirect na /sign-in (kontrola w zasobie, nie tylko w proxy)
  return <MailerApp />;
}
