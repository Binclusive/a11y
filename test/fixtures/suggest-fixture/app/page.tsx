import {
  Avatar,
  Button,
  Checkbox,
  Dropdown,
  IconButton,
  Link,
  Modal,
  Select,
  Tabs,
  TextField,
} from "@acme/ui";
import { Widget } from "~/components/widget";

export default function Page() {
  return (
    <Modal>
      <Tabs>
        <Dropdown />
        <Avatar />
        <Button>Save</Button>
        <IconButton />
        <Link href="/next">Next</Link>
        <TextField label="Name" />
        <Select />
        <Checkbox />
        <Widget />
      </Tabs>
    </Modal>
  );
}
