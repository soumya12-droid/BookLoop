import { Link } from 'react-router-dom';
import { EmptyState } from '../components/States';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export default function NotFound() {
  useDocumentTitle('Page not found');
  return (
    <div className="container page">
      <EmptyState title="This page isn’t on our shelves"
        action={<Link className="btn btn--primary" to="/">Back to Discover</Link>}>
        The link may be out of date or mistyped.
      </EmptyState>
    </div>
  );
}
