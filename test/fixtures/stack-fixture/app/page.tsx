import { Button, TextField } from "@mui/material";
import { Bell, Check, Home, Search, Star, User } from "lucide-react";
import { Card } from "~/components/card";

export default function Page() {
  return (
    <Card>
      <Home />
      <Search />
      <Bell />
      <Star />
      <User />
      <Check />
      <TextField label="Name" />
      <Button>Submit</Button>
    </Card>
  );
}
