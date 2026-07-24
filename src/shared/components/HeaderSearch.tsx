import { Search } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";

/** Opens the dedicated search page instead of growing an inline header form. */
export function HeaderSearch() {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  if (pathname === "/search") return null;

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      title="搜索主播、房间号、标题"
      aria-label="搜索主播、房间号、标题"
      onClick={() => navigate("/search")}
    >
      <Search />
    </Button>
  );
}
